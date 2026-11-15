'use client';

import { Slider } from '@/components/ui/slider';
import { httpOrigin } from '@/lib/net/coop';
import { SPRITES } from '@/lib/sim/settings';
import { MineSpritesSection, SKIN_GROUPS } from './player-profile-ui';
import styles from './profile-settings.module.css';

export function ProfileAppearance({ accountName, sprite, wornSprite, scale, onPick, onScale, onWear, mineHighlight }: {
  accountName: string; sprite: string; wornSprite: string; scale: number;
  onPick: (id: string) => void; onScale: (scale: number) => void;
  onWear: (id: string) => Promise<void>; mineHighlight?: string | null;
}) {
  const selected = SPRITES.find((item) => item.id === sprite);
  const src = selected?.src || (sprite ? `${httpOrigin()}/sprites/file/${encodeURIComponent(sprite)}.png` : '');
  return <>
    <h3 className={styles.heading}>Внешность</h3>
    <div className={styles.appearance}>
      <figure className={styles.preview}>
        {src ? <img src={src} alt="Выбранный окрас персонажа" draggable={false} /> : <span>Окрас не выбран</span>}
        <figcaption>{selected?.name || 'Свой окрас'}</figcaption>
      </figure>
      <a className={`${styles.action} ${styles.skinmaker}`} href="https://paint.phainonsmilk.ru/" target="_blank" rel="noopener noreferrer">Нарисовать окрас</a>
      <div className={styles.groups} aria-label="Дополнительные окрасы">
        <p className={styles.label}>Дополнительные окрасы</p>
        {SKIN_GROUPS.map((group) => <details key={group.id} className={styles.group}>
          <summary>{group.name}<span aria-hidden>⌄</span></summary>
          <div className={styles.swatches}>
            {group.sprites.map((item) => <button key={item.id} type="button" aria-pressed={sprite === item.id}
              className={styles.swatch} title={item.name} onClick={() => onPick(item.id)}>
              <img src={item.src} alt="" draggable={false} /><span>{item.name}</span>
            </button>)}
          </div>
        </details>)}
      </div>
    </div>
    <label className={styles.growth}>Рост персонажа — {scale}%
      <Slider value={[scale]} min={60} max={100} step={1} aria-label="Рост персонажа" onValueChange={([value]) => { if (typeof value === 'number') onScale(Math.round(value)); }} />
    </label>
    <MineSpritesSection accountName={accountName} draftSprite={sprite} wornSprite={wornSprite}
      onPick={onPick} onWear={onWear} mineHighlight={mineHighlight} />
  </>;
}
