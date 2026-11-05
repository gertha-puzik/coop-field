/**
 * Verbatim strike pipeline carved out of simulator.tsx (W5b stage 2,
 * behavior-preserving): armor preset publishing effect, pending-strikes
 * cleanup ref, landStrike/doStrike combat callbacks and the doStrikeRef
 * wiring effect. Contract: a custom React hook holding exactly the original
 * effects in their original relative order (deps arrays unchanged);
 * bodies byte-identical, closures over the deps object fields recreated
 * every render exactly like the inline code they replace.
 */
import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { CoopDummyPos } from '@/lib/net/coop';
import type { DummyConfig, SimSettings, SpriteId, StrikeZone, WindowKey } from '@/lib/sim/settings';
import type { Engine } from '../sim-model';
import { RAB_ID } from '@/lib/sim/engine-consts';
import { anchorOf, entrySide, spriteBoxOf } from '@/lib/sim/geometry';
import { createCoopClient } from '@/lib/net/coop';
import { inWindow, rayBox, resolveZonePixel, wrap360 } from '@/lib/sim/settings';
import { pickStrikeTarget, pruneRemoteEnergy, strikeResponseMs, type CharRef } from '@/lib/sim/targeting';
import { type CombatLogEntry, type CombatState, mergeLog } from '@/lib/sim/combat-log';

export interface StrikeDeps {
  settings: SimSettings;
  settingsRef: RefObject<SimSettings>;
  combatRef: RefObject<CombatState>;
  doStrikeRef: RefObject<(() => void) | null>;
  engineRef: RefObject<Engine>;
  jellyRef: RefObject<Record<string, number>>;
  liveRemotesRef: RefObject<DummyConfig[]>;
  mainSavedRef: RefObject<{ col: number; row: number; angle: number } | null>;
  netRef: RefObject<ReturnType<typeof createCoopClient> | null>;
  rabOnRef: RefObject<boolean>;
  remoteBlockRef: RefObject<Set<number>>;
  spritesRef: RefObject<Partial<Record<SpriteId, HTMLImageElement>>>;
  rabExtra: () => CharRef[];
  setCombat: Dispatch<SetStateAction<CombatState>>;
}

export function useStrike(deps: StrikeDeps) {
  const {
    settings,
    settingsRef,
    combatRef,
    doStrikeRef,
    engineRef,
    jellyRef,
    liveRemotesRef,
    mainSavedRef,
    netRef,
    rabOnRef,
    remoteBlockRef,
    spritesRef,
    rabExtra,
    setCombat,
  } = deps;
  /* ---------- броня ---------- */

  /** Пресет брони уходит на сервер при смене кнопкой (и повторяется после
   *  переподключения — см. onYou). Сервер режет этой бронёй входящий урон;
   *  соседям значение не рассылается — они видят уже порезанный урон в fight.
   *  Пока сокета нет, emit просто молчит: onYou всё равно пришлёт запрос заново. */
  const armorLevel = settings.combat.armorLevel;
  useEffect(() => {
    netRef.current?.emit('armor', { armor: armorLevel / 10 });
  }, [armorLevel]);

  /* ---------- удар (клавиша I) ---------- */

  /** Отложенные удары «в полёте» (закрываются при размонтировании компонента). */
  const pendingStrikesRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const id of pendingStrikesRef.current) window.clearTimeout(id);
      pendingStrikesRef.current = [];
    },
    [],
  );

  /** Применение результата удара: расчёт и отправка на сервер — сразу при нажатии,
   *  локальные видимые эффекты — с откликом удара (visual=true). */
  const landStrike = useCallback((snap: { angle: number; col: number; row: number; flightMs?: number }, visual: boolean) => {
    const s = settingsRef.current;
    const e = engineRef.current;
    const now = performance.now();
    const cellCX = (cc: number) => cc * s.field.cellW + s.field.cellW / 2;
    const cellCY = (cr: number) => cr * s.field.cellH + s.field.cellH / 2;
    const selfId = s.controlled;
    const mp = selfId === 'main' ? null : mainSavedRef.current;

    /** Кого задел удар: единственный соседний персонаж, а если соседних несколько —
     *  тот, на который точнее наведена стрела. null — рядом никого. */
    const t = pickStrikeTarget(s, snap.col, snap.row, snap.angle, selfId, mp, liveRemotesRef.current, rabExtra());
    /** Лаповая зона пресета бьющего: урон, который уходит на сервер для удара по блоку. */
    const zPaws = s.combat.zones.find((zz) => zz.id === 'paws');
    /** Поражённый персонаж (для списания его энергии; null — попадания не было). */
    let struck: CharRef | null = null;
    /** Урон по цели этим ударом (null — попадания не было). */
    let hitDamage: number | null = null;
    let entry: CombatLogEntry;

    /** Всплывающая надпись «зона -урон%» над поражённым (вылетает вверх и тает). */
    const pushDamageLabel = (z: StrikeZone, tc: number, tr: number) => {
      e.labels.push({
        x: cellCX(tc),
        y: cellCY(tr) - s.field.cellH * 0.35,
        born: now,
        text: `${z.name} -${z.damage}%`,
        color: z.color,
      });
    };

    if (!t) {
      // рядом никого — удар в пустоту (без надписи и без строки в логе)
      entry = { target: '', zoneId: 'miss', zoneLabel: 'мимо', count: 1, actor: 'Я' };
    } else {
      const tCol = t.col;
      const tRow = t.row;
      const dx = tCol - snap.col;
      const dy = tRow - snap.row;
      const targetBlocking =
        t.id.startsWith('p') && remoteBlockRef.current.has(Number(t.id.slice(1)));
      // Прицельная зона считается ДО блока: хвост — исключение из блока, поэтому
      // важно знать, куда именно шла стрела, даже по блокирующему игроку.
      let aimed: StrikeZone | null | undefined;
      if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
        // Удар с диагонали: зона задаётся стойкой относительно цели, а стрела обязана
        // стоять в окне замедления направления на цель:
        //  слева-сверху (стрела вправо-вниз, окно 45°) и справа-сверху (влево-вниз, 135°) — Морда,
        //  слева-снизу (стрела вправо-вверх, 315°) — Лапы, справа-снизу (влево-вверх, 225°) — Хвост.
        // Вне окна направления — промах, из полос тела с диагонали ничего не берётся.
        const phi = wrap360((Math.atan2(dy, dx) * 180) / Math.PI);
        const forcedId = phi === 45 || phi === 135 ? 'muzzle' : phi === 225 ? 'tail' : 'paws';
        const win = s.slowdown.windows[String(phi) as WindowKey];
        aimed = win && inWindow(snap.angle, win) ? s.combat.zones.find((zz) => zz.id === forcedId) : undefined;
      } else {
        // Прямая стойка: зона — полоса тела, в которую входит луч стрелы.
        // Луч идёт из точки закрепления стрелы под её углом; промах — луч не задел тело.
        const sprT = spritesRef.current[t.sprite] ?? null;
        const sprSelf = spritesRef.current[selfId === 'main' ? s.character.sprite : (s.dummies.find((d) => d.id === selfId)?.sprite ?? s.character.sprite)] ?? null;
        const scaleSelf = selfId === 'main' ? s.character.spriteScale : (s.dummies.find((d) => d.id === selfId)?.scale ?? s.character.spriteScale);
        const a = anchorOf(s, sprSelf ? sprSelf.width / sprSelf.height : 2 / 3, snap.col, snap.row, scaleSelf);
        const box = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, tCol, tRow, t.scale);
        const rad = (snap.angle * Math.PI) / 180;
        const hit = rayBox(a.ax, a.ay, Math.cos(rad), Math.sin(rad), box.x, box.y, box.w, box.h);
        aimed = hit.hit ? resolveZonePixel(hit.ny, entrySide(hit), s.combat.zones) : null;
      }
      // Блок цели: ЛЮБОЙ удар по блокирующему игроку — в «Лапы», куда бы стрела
      // ни шла и с какой стойки ни бьём (прямая/диагональ, любое окно).
      // Единственное исключение — хвост: удар в хвост блок не ловит и остаётся
      // хвостом (хвост — зона с самым маленьким получаемым уроном).
      const z = targetBlocking && zPaws ? (aimed && aimed.id === 'tail' ? aimed : zPaws) : aimed;
      if (z) {
        hitDamage = z.damage;
        struck = t;
        // Манекены и РАБ без брони: полученный урон = урон зоны. По живым игрокам
        // строку с реальным уроном (после брони) принесёт fight от сервера.
        entry = { target: t.name, zoneId: z.id, zoneLabel: z.name, count: 1, actor: 'Я', dmg: hitDamage };
      } else {
        // луч прошёл мимо тела — промах, без надписи и без строки в логе
        entry = { target: '', zoneId: 'miss', zoneLabel: 'мимо', count: 1, actor: 'Я' };
      }
    }

    // Локальные эффекты (манекен, промах, РАБ, оффлайн) проявляются с откликом удара:
    // сетевой удар уже улетел при нажатии — окно отклика бьющего на цель не тратим.
    if (!visual) {
      const id = window.setTimeout(() => landStrike(snap, true), strikeResponseMs(settingsRef.current));
      pendingStrikesRef.current.push(id);
      return;
    }

    // Попадание по живому соседу уходит на сервер. Строку лога и урон принесёт fight,
    // иначе удар останется только в состоянии бьющего.
    if (
      hitDamage !== null &&
      struck &&
      selfId === 'main' &&
      struck.id.startsWith('p') &&
      netRef.current?.ready
    ) {
      const target = Number(struck.id.slice(1));
      if (Number.isInteger(target)) {
        // Урон едет вместе с ударом: это пресет «Урон игрока» бьющего.
        // Сервер нормализует число и раздаёт fight с этим уроном всей комнате —
        // иначе у цели всегда будет серверная таблица, и пресет 0,0–0,9 не работает.
        // pawsDamage — лаповый урон пресета: если блок встанет за время полёта,
        // сервер переведёт удар в «Лапы» и спишет именно его. Исключение — хвост:
        // блок не переносит удар из хвоста в «Лапы». flightMs — окно отклика
        // бьющего: столько удар «летит» на сервере, и блок успевает его поймать.
        netRef.current.emit('strike', {
          target,
          zone: entry.zoneId,
          angle: snap.angle,
          damage: hitDamage,
          pawsDamage: zPaws ? zPaws.damage : undefined,
          flightMs: snap.flightMs,
        });
        return;
      }
    }

    if (hitDamage !== null && struck) {
      const z = s.combat.zones.find((zz) => zz.id === entry.zoneId);
      if (z) pushDamageLabel(z, struck.col, struck.row);
      // Попадание по мишени РАБ качает её «желе»; бьющий анимирует локально,
      // остальных догоняет rabHit от сервера — анимация видна всей комнате.
      if (struck.id === RAB_ID) {
        jellyRef.current[RAB_ID] = 1;
        if (netRef.current?.ready) {
          netRef.current.emit('rabHit', {
            zone: entry.zoneId,
            part: entry.zoneLabel,
            damage: hitDamage,
          });
        }
      }
    }

    // энергия и лог обновляются функционально от последнего состояния,
    // чтобы не затирать параллельные изменения (например, тик регенерации)
    setCombat((prev) => {
      const es = Math.max(1, s.combat.energyStart);
      let playerEnergy = prev.playerEnergy;
      const de = pruneRemoteEnergy(prev.dummyEnergy, s, liveRemotesRef.current, rabOnRef.current ? [RAB_ID] : []);
      // энергия тратится только при попадании в зону удара — промах бесплатен;
      // платит тот, кем управляем (свой кот — playerEnergy, манекен — своя энергия)
      if (hitDamage !== null) {
        if (selfId === 'main') playerEnergy = Math.max(0, playerEnergy - s.combat.strikeCost);
        else de[selfId] = Math.max(0, (de[selfId] ?? es) - s.combat.strikeCost);
      }
      // урон списывается с энергии того, в кого пришёлся удар
      if (hitDamage !== null && struck) {
        if (struck.id === 'main') playerEnergy = Math.max(0, playerEnergy - hitDamage);
        else de[struck.id] = Math.max(0, (de[struck.id] ?? es) - hitDamage);
      }
      // лог пишется последовательно: каждый удар — новая строка наверх; счётчик растёт
      // только когда удар совпал с самой верхней строкой (тот же бьющий, цель и зона)
      return { playerEnergy, dummyEnergy: de, log: mergeLog(prev.log, entry) };
    });
  }, []);

  const doStrike = useCallback(() => {
    const s = settingsRef.current;
    const e = engineRef.current;
    if (!s.arrow.battleMode) return;
    // В блоке бить нельзя.
    if (e.blocking) return;
    // удар не проходит, пока стрела вращается (J/L) — сначала нужно остановить стрелу
    if (e.rot !== 0 || e.rotActive !== 0) return;
    // В комнате без связи удар по чужим котам локально не моделируется:
    // иначе получился бы «зомби»-урон, которого нет у остальных.
    if (s.controlled === 'main' && liveRemotesRef.current.length > 0 && !netRef.current?.ready) return;
    const now = performance.now();
    const resp = strikeResponseMs(s);
    // удары не чаще, чем раз в отклик (170 мс по умолчанию): ни спам, ни удержание
    // клавиши удара не дают больше одного удара в этот интервал
    if (now - e.lastStrike < resp) return;
    // энергии не хватает — удар просто не начинается (без всплывающих подсказок);
    // платит тот, кем управляем
    const esNow = Math.max(1, s.combat.energyStart);
    const myEnergy =
      s.controlled === 'main'
        ? combatRef.current.playerEnergy
        : (combatRef.current.dummyEnergy[s.controlled] ?? esNow);
    if (myEnergy < s.combat.strikeCost) return;
    e.lastStrike = now;
    // Стойка, угол, расчёт и отправка удара — в момент нажатия. Раньше удар ещё
    // resp ждал на клиенте, а сервер потом то же окно полёта: до касания шло
    // ~два отклика. Теперь окно одно, серверное (flightMs) — блок цели успевает.
    const snap = { angle: e.angle, col: e.col, row: e.row, flightMs: resp };
    landStrike(snap, false);
  }, [landStrike]);

  useEffect(() => {
    doStrikeRef.current = doStrike;
  }, [doStrike]);
}

