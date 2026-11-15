'use client';

/**
 * Аватарка в шапке профиля (спека 2026-11-14-avatar-crop-paint). Владельцу —
 * меню: загрузить целиком в квадратный холст (512×512), дорисовать пикселями 64×64
 * поверх текущей картинки, убрать (второй клик). Загрузка — существующий
 * /cfg/avatars/mine, сервер не меняется.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { httpDeleteAvatar, httpUploadAvatar, humanAvatarError } from '@/lib/net/http-avatars';

import { imageToPixels } from './avatar-pixels';
import { BannerCropper } from './banner-cropper';
import { BannerPainter } from './banner-painter';
import { Icon } from './profile-icons';
import styles from './profile-card.module.css';

const AVATAR_SIDE = 512;
const GRID = 64;
const CLEAR = [0, 0, 0, 0] as const;

export function ProfileAvatar({
  mine,
  name,
  faceUrl,
  hasImage,
  onChanged,
  onError,
}: {
  mine: boolean;
  name: string;
  /** Что показано (своя картинка или спрайт персонажа), уже абсолютный URL. */
  faceUrl: string | null;
  /** Есть загруженная картинка (тогда доступно «Убрать»). */
  hasImage: boolean;
  onChanged?: () => void | Promise<void>;
  onError: (text: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [painting, setPainting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.(`.${styles.avatarWrap}`)) setMenu(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const upload = async (blob: Blob) => {
    setBusy(true);
    onError(null);
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    const res = await httpUploadAvatar(new File([blob], `avatar.${ext}`, { type: blob.type }));
    setBusy(false);
    if (!res.ok) {
      onError(humanAvatarError(res.reason, 'Сохранить аватарку не удалось.'));
      return;
    }
    setCropFile(null);
    setPainting(false);
    await onChanged?.();
  };

  const remove = async () => {
    if (!armed) {
      setArmed(true);
      window.setTimeout(() => setArmed(false), 5000);
      return;
    }
    setMenu(false);
    setArmed(false);
    setBusy(true);
    const res = await httpDeleteAvatar();
    setBusy(false);
    if (!res.ok) {
      onError(humanAvatarError(res.reason, 'Убрать аватарку не удалось.'));
      return;
    }
    await onChanged?.();
  };

  const loadBase = useCallback(() => imageToPixels(faceUrl, GRID, GRID), [faceUrl]);

  const face = <>
    {faceUrl ? <img src={faceUrl} alt={name} draggable={false} /> : <span aria-hidden>◇</span>}
    <svg className={styles.faceFrame} viewBox="0 0 200 260" preserveAspectRatio="none" aria-hidden="true">
      <path d="M100 3 112 17H166Q184 17 184 35L194 45V239Q194 253 180 253H20Q6 253 6 239V45L16 35Q16 17 34 17H88Z" />
      <path d="M100 13 109 24H164Q177 24 177 39L186 49V236Q186 245 176 245H24Q14 245 14 236V49L23 39Q23 24 36 24H91Z" />
      <path d="m100 3 7 10-7 11-7-11Z" />
    </svg>
  </>;

  if (!mine) return <div className={styles.heroFace}>{face}</div>;

  return (
    <div className={styles.avatarWrap}>
      <button
        type="button"
        className={`${styles.heroFace} ${styles.heroFaceBtn}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label="Изменить аватарку"
        disabled={busy}
        onClick={() => setMenu((m) => !m)}
      >
        {face}
        <span className={styles.faceEdit} aria-hidden>
          <Icon name={busy ? 'clock' : 'pencil'} size={16} />
        </span>
      </button>
      {menu ? (
        <div className={`${styles.bannerMenu} ${styles.avatarMenu}`} role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              fileRef.current?.click();
            }}
          >
            <Icon name="image" size={16} /> Загрузить картинку…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setPainting(true);
            }}
          >
            <Icon name="brush" size={16} /> Дорисовать…
          </button>
          {hasImage ? (
            <button type="button" role="menuitem" className={armed ? styles.menuDanger : undefined} onClick={() => void remove()}>
              <Icon name="trash" size={16} /> {armed ? 'Точно убрать?' : 'Убрать аватарку'}
            </button>
          ) : null}
        </div>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) setCropFile(f);
        }}
      />
      {cropFile ? (
        <BannerCropper
          file={cropFile}
          frameW={AVATAR_SIDE}
          frameH={AVATAR_SIDE}
          fit="contain"
          title="Аватарка"
          busy={busy}
          onDone={(b) => void upload(b)}
          onCancel={() => setCropFile(null)}
        />
      ) : null}
      {painting ? (
        <BannerPainter
          width={GRID}
          height={GRID}
          scale={AVATAR_SIDE / GRID}
          loadBase={loadBase}
          eraseColor={CLEAR}
          title="Дорисовать аватарку"
          hint="Каждая клетка — один пиксель аватарки 64×64. Ластик делает прозрачным."
          baseLabel="Начать с моей аватарки"
          square
          busy={busy}
          onDone={(b) => void upload(b)}
          onCancel={() => setPainting(false)}
        />
      ) : null}
    </div>
  );
}
