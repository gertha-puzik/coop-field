'use client';

import { useEffect, useRef, useState } from 'react';
import type { CoopWhoami } from '@/lib/net/protocol';
import { httpMyProfile, type ProfileMe } from '@/lib/net/http-profiles';

/**
 * Compile-time вариант: хук зовут только из entry-screen; в grotto-сборке
 * ветка IS_ELYRIA мертва и /profiles не попадает в бандл через DCE.
 */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

/** Потолок ожидания /profiles/me на экране входа — без него деплой-блип
 *  держит «Готовим ваш профиль» минутами (owner report 2026-11-12). */
const PROFILE_TIMEOUT_MS = 8000;

type SpApply = {
  onApplySpeed: (v: number) => void;
  onApplyDamage: (v: number) => void;
  onApplyArmor: (v: number) => void;
};

/**
 * Тихий fetch профиля для Элизии: СП применяются один раз; сбой/таймаут →
 * meFailed (комнаты открываются на дефолтах). Гость без accountId fetch не
 * делает — иначе ?name= из URL врёт «готовим профиль».
 */
export function useElyriaEntryProfile(whoami: CoopWhoami | null | undefined, apply: SpApply) {
  const [me, setMe] = useState<{ accountId: string; profile: ProfileMe } | null>(null);
  const [meFailed, setMeFailed] = useState(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const accountId = whoami?.ok ? whoami.accountId : undefined;
  const meProfile =
    IS_ELYRIA && me && whoami?.ok && whoami.accountId && me.accountId === whoami.accountId
      ? me.profile
      : null;

  useEffect(() => {
    if (!IS_ELYRIA) return;
    if (!whoami?.ok || !whoami.accountId) {
      setMe(null);
      setMeFailed(false);
      return;
    }
    let dead = false;
    setMeFailed(false);
    const failTimer = window.setTimeout(() => {
      if (!dead) setMeFailed(true);
    }, PROFILE_TIMEOUT_MS);
    void (async () => {
      // Статический импорт http-profiles: динамический чанк 404 → вечная
      // «Готовим ваш профиль» (owner report 2026-11-08).
      let profile: ProfileMe | null = null;
      try {
        const res = await httpMyProfile();
        if (dead) return;
        if (!res.ok || !res.profile) {
          setMeFailed(true);
          return;
        }
        profile = res.profile;
        setMe({ accountId: whoami.accountId!, profile });
      } catch {
        if (!dead) setMeFailed(true);
        return;
      } finally {
        window.clearTimeout(failTimer);
      }
      if (dead || !profile?.sp) return;
      const sp = profile.sp;
      const { onApplySpeed, onApplyDamage, onApplyArmor } = applyRef.current;
      if (typeof sp.periodSec === 'number' && Number.isFinite(sp.periodSec)) {
        onApplySpeed(Math.round(sp.periodSec * 10) / 10);
      }
      if (typeof sp.damageLevel === 'number') onApplyDamage(sp.damageLevel);
      if (typeof sp.armorLevel === 'number') onApplyArmor(sp.armorLevel);
    })();
    return () => {
      dead = true;
      window.clearTimeout(failTimer);
    };
  }, [whoami?.ok, accountId]);

  return { meProfile, meFailed };
}
