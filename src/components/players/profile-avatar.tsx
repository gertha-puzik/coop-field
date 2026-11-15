'use client';

/** Portrait fills the inner SVG window. The lower-left pencil opens the
 * shared avatar/banner menu. GIF bytes bypass the cropper to preserve animation. */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { httpDeleteAvatar, httpUploadAvatar, humanAvatarError } from '@/lib/net/http-avatars';

import { imageToPixels } from './avatar-pixels';
import { BannerCropper } from './banner-cropper';
import { BannerPainter } from './banner-painter';
import { Icon } from './profile-icons';
import styles from './profile-card.module.css';
import avatarStyles from './profile-avatar.module.css';

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
  bannerMenu,
  externalBusy = false,
}: {
  mine: boolean;
  name: string;
  /** Что показано (своя картинка или спрайт персонажа), уже абсолютный URL. */
  faceUrl: string | null;
  /** Есть загруженная картинка (тогда доступно «Убрать»). */
  hasImage: boolean;
  onChanged?: () => void | Promise<void>;
  onError: (text: string | null) => void;
  bannerMenu?: (close: () => void) => ReactNode;
  externalBusy?: boolean;
}) {
  const clipId = useId();
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
    const ext = blob.type === 'image/gif' ? 'gif' : blob.type === 'image/png' ? 'png' : 'jpg';
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

  const selectUpload = async (file: File) => {
    if (busy) return;
    onError(null);
    if (file.size > 100 * 1024 * 1024) {
      onError('Файл больше 100 МБ — выберите поменьше.');
      return;
    }
    setBusy(true);
    try {
      const signature = await file.slice(0, 6).text();
      if (signature === 'GIF87a' || signature === 'GIF89a') {
        // Оригинальные байты: canvas/cropper уничтожают анимацию.
        await upload(new File([file], 'avatar.gif', { type: 'image/gif' }));
      } else {
        setBusy(false);
        setCropFile(file);
      }
    } catch {
      setBusy(false);
      onError('Не удалось прочитать картинку. Попробуйте ещё раз.');
    }
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
    <div className={avatarStyles.image} style={{ clipPath: `url(#${clipId})` }}>
      {faceUrl ? <img src={faceUrl} alt={name} draggable={false} style={{ objectFit: 'cover', borderRadius: 0 }} /> : <span aria-hidden>◇</span>}
    </div>
    <svg className={styles.faceFrame} viewBox="0 0 200 260" preserveAspectRatio="none" aria-hidden="true">
      <defs><clipPath id={clipId} clipPathUnits="objectBoundingBox"><path d="M.18 .0923H.82Q.885 .0923 .885 .15L.93 .1885V.9077Q.93 .9423 .88 .9423H.12Q.07 .9423 .07 .9077V.1885L.115 .15Q.115 .0923 .18 .0923Z" /></clipPath></defs>
      <path d="M100 3 112 17H166Q184 17 184 35L194 45V239Q194 253 180 253H20Q6 253 6 239V45L16 35Q16 17 34 17H88Z" />
      <path d="M100 13 109 24H164Q177 24 177 39L186 49V236Q186 245 176 245H24Q14 245 14 236V49L23 39Q23 24 36 24H91Z" />
      <path d="m100 3 7 10-7 11-7-11Z" />
    </svg>
  </>;

  if (!mine) return <div className={styles.heroFace}>{face}</div>;

  return (
    <div className={styles.avatarWrap}>
      <div className={styles.heroFace}>{face}</div>
      <button type="button" className={`${styles.faceEdit} ${avatarStyles.editButton}`}
        aria-haspopup="menu" aria-expanded={menu} aria-label="Изменить аватарку и фон профиля"
        disabled={busy || externalBusy} onClick={() => setMenu((m) => !m)}>
        <Icon name={busy || externalBusy ? 'clock' : 'pencil'} size={16} />
      </button>
      {menu ? (
        <div className={`${styles.bannerMenu} ${styles.avatarMenu}`} role="menu" aria-label="Изображения профиля">
          <span className={avatarStyles.menuLabel}>Аватарка</span>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              fileRef.current?.click();
            }}
          >
            <Icon name="image" size={16} /> <span>Загрузить картинку / GIF…<small className={styles.uploadHint}>GIF до 100 МБ, анимация сохраняется</small></span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setPainting(true);
            }}
          >
            <Icon name="brush" size={16} /> {faceUrl && /\.gif(?:\?|$)/i.test(faceUrl) ? 'Дорисовать (без анимации)…' : 'Дорисовать…'}
          </button>
          {hasImage ? (
            <button type="button" role="menuitem" className={armed ? styles.menuDanger : undefined} onClick={() => void remove()}>
              <Icon name="trash" size={16} /> {armed ? 'Точно убрать?' : 'Убрать аватарку'}
            </button>
          ) : null}
          {bannerMenu ? <><span className={avatarStyles.menuLabel}>Фон профиля</span>{bannerMenu(() => setMenu(false))}</> : null}
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
          if (f) void selectUpload(f);
        }}
      />
      {cropFile ? (
        <BannerCropper
          file={cropFile}
          frameW={400}
          frameH={AVATAR_SIDE}
          fit="cover"
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
