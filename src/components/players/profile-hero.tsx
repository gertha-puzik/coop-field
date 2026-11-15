'use client';

/** Profile banner and identity. Image editing lives in the avatar pencil menu;
 * banner and avatar keep their existing upload, painting and removal flows. */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { httpDeleteBanner, httpUploadBanner, humanBannerError } from '@/lib/net/http-banners';
import { httpOrigin } from '@/lib/net/coop';
import { BANNER_H, BANNER_W, generateBanner, paintPixels } from '@/lib/sim/banner-gen';

import { BannerCropper } from './banner-cropper';
import { BannerPainter } from './banner-painter';
import { ProfileAvatar } from './profile-avatar';
import { Icon } from './profile-icons';
import { ruDate, type PresenceTone } from './players-format';
import styles from './profile-card.module.css';

const DOT: Record<PresenceTone, string> = {
  online: styles.dotOnline,
  traveling: styles.dotTravel,
  away: styles.dotAway,
  resting: styles.dotRest,
};

function GeneratedBanner({ seed }: { seed: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx) paintPixels(ctx, generateBanner(seed), 1);
  }, [seed]);
  return (
    <canvas
      ref={ref}
      width={BANNER_W}
      height={BANNER_H}
      className={styles.heroGen}
      role="img"
      aria-label="Сгенерированная шапка профиля"
    />
  );
}

export type ProfileHeroProps = {
  accountId: string;
  mine: boolean;
  name: string;
  bioLine: string;
  banner: string | null;
  faceUrl: string | null;
  /** Своя загруженная аватарка есть (меню предлагает «Убрать»). */
  hasAvatar?: boolean;
  createdAt: number;
  presence: { tone: PresenceTone; text: string };
  now: number;
  /** Кнопки дружбы (чужой профиль). */
  actions?: ReactNode;
  /** После смены шапки — освежить свою карточку снаружи. */
  onBannerChanged?: () => void | Promise<void>;
  /** После смены аватарки — то же. */
  onAvatarChanged?: () => void | Promise<void>;
};

/** Относительный путь картинки сервера комнат → абсолютный (локально фронт и
 *  комната на разных портах; на проде httpOrigin — тот же адрес сайта). */
function assetUrl(u: string): string {
  return u.startsWith('/') ? `${httpOrigin()}${u}` : u;
}

export function ProfileHero({
  accountId,
  mine,
  name,
  bioLine,
  banner,
  faceUrl,
  hasAvatar = false,
  createdAt,
  presence,
  now,
  actions,
  onBannerChanged,
  onAvatarChanged,
}: ProfileHeroProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [idCopied, setIdCopied] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [painting, setPainting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [armedRemove, setArmedRemove] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const upload = async (blob: Blob) => {
    setBusy(true);
    setNote(null);
    const ext = blob.type === 'image/gif' ? 'gif' : blob.type === 'image/png' ? 'png' : 'jpg';
    const res = await httpUploadBanner(new File([blob], `banner.${ext}`, { type: blob.type }));
    setBusy(false);
    if (!res.ok) {
      setNote(humanBannerError(res.reason, 'Сохранить шапку не удалось.'));
      return;
    }
    setCropFile(null);
    setPainting(false);
    await onBannerChanged?.();
  };

  const selectUpload = async (file: File) => {
    if (busy) return;
    setNote(null);
    if (file.size > 100 * 1024 * 1024) {
      setNote('Файл больше 100 МБ — выберите поменьше.');
      return;
    }
    setBusy(true);
    try {
      const signature = await file.slice(0, 6).text();
      if (signature === 'GIF87a' || signature === 'GIF89a') {
        // Оригинальные байты: canvas/cropper уничтожают анимацию.
        await upload(new File([file], 'banner.gif', { type: 'image/gif' }));
      } else {
        setBusy(false);
        setCropFile(file);
      }
    } catch {
      setBusy(false);
      setNote('Не удалось прочитать картинку. Попробуйте ещё раз.');
    }
  };

  const remove = async () => {
    if (!armedRemove) {
      setArmedRemove(true);
      window.setTimeout(() => setArmedRemove(false), 5000);
      return;
    }
    setArmedRemove(false);
    setBusy(true);
    const res = await httpDeleteBanner();
    setBusy(false);
    if (!res.ok) {
      setNote(humanBannerError(res.reason, 'Убрать шапку не удалось.'));
      return;
    }
    await onBannerChanged?.();
  };

  return (
    <div className={styles.hero}>
      <div className={styles.heroBanner}>
        {banner ? (
          <div className={styles.heroImg} style={{ backgroundImage: `url("${assetUrl(banner)}")` }} role="img" aria-label="Шапка профиля" />
        ) : (
          <GeneratedBanner seed={accountId} />
        )}
        <div className={styles.heroShade} aria-hidden />
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden
          onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void selectUpload(file); }} />

        <div className={styles.heroInfo}>
          <ProfileAvatar
            mine={mine}
            name={name}
            faceUrl={faceUrl ? assetUrl(faceUrl) : null}
            hasImage={hasAvatar}
            onChanged={onAvatarChanged}
            onError={setNote}
            externalBusy={busy}
            bannerMenu={(close) => <>
              <button type="button" role="menuitem" onClick={() => { close(); fileRef.current?.click(); }}>
                <Icon name="image" size={16} /><span>Загрузить фон / GIF…<small className={styles.uploadHint}>GIF до 100 МБ, анимация сохраняется</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => { close(); setPainting(true); }}><Icon name="brush" size={16} />Нарисовать фон…</button>
              {banner ? <button type="button" role="menuitem" className={armedRemove ? styles.menuDanger : undefined} onClick={() => { if (armedRemove) close(); void remove(); }}>
                <Icon name="trash" size={16} />{armedRemove ? 'Точно убрать фон?' : 'Убрать фон'}
              </button> : null}
            </>}
          />
          <div className={styles.heroText}>
            <h1 className={styles.heroName}>
              {name}
              <button type="button" className={styles.copyId} title={`Скопировать ID: ${accountId}`} onClick={async () => {
                try { await navigator.clipboard.writeText(accountId); setIdCopied(true); }
                catch { setIdCopied(false); }
              }}>№{accountId.slice(0, 8)} <span aria-hidden>⧉</span></button>
              <span className={styles.copyStatus} role="status">{idCopied ? 'ID скопирован' : ''}</span>
            </h1>
            {bioLine ? <p className={styles.heroBio}>{bioLine}</p> : null}
            <div className={styles.heroPills}>
              <span className={styles.heroPill}>
                <Icon name="calendar" size={14} /> На сайте с {ruDate(createdAt)}
              </span>
              <span className={styles.heroPill}>
                <span className={`${styles.dot} ${DOT[presence.tone]}`} aria-hidden /> {presence.text}
              </span>
            </div>
          </div>
        </div>
      </div>
      {note ? <p className={styles.heroNote}>{note}</p> : null}
      {actions ? <div className={styles.heroActs}>{actions}</div> : null}

      {cropFile ? (
        <BannerCropper file={cropFile} busy={busy} onDone={(b) => void upload(b)} onCancel={() => setCropFile(null)} />
      ) : null}
      {painting ? (
        <BannerPainter
          loadBase={() => generateBanner(accountId)}
          busy={busy}
          onDone={(b) => void upload(b)}
          onCancel={() => setPainting(false)}
        />
      ) : null}
    </div>
  );
}
