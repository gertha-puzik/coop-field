'use client';
import type { PublicProfile } from '@/lib/net/http-profiles';
import { Icon } from './profile-icons';
import card from './profile-card.module.css';
import s from './profile-user-info.module.css';
const LINKS=[['discord','Discord','DC'],['telegram','Telegram','➤'],['youtube','YouTube','▶'],['vk','ВКонтакте','VK'],['website','Сайт','↗']] as const;
function SocialGlyph({network}:{network:string}) {
  if(network==='discord') return <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden><path d="M6 5 9 4l1 2h4l1-2 3 1c3 4 4 8 3 12l-4 2-2-2 2-1c-4 2-6 2-10 0l2 1-2 2-4-2C2 13 3 9 6 5Z"/><circle cx="8.5" cy="12" r="1.5" fill="#211a3d"/><circle cx="15.5" cy="12" r="1.5" fill="#211a3d"/></svg>;
  if(network==='telegram') return <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden><path d="m2 11 19-8-4 18-6-6-4 4 1-7 9-6-11 5Z"/></svg>;
  if(network==='youtube') return <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden><rect x="2" y="5" width="20" height="14" rx="4" fill="currentColor"/><path d="m10 9 6 3-6 3Z" fill="#211a3d"/></svg>;
  return <span aria-hidden>{network==='vk'?'VK':'↗'}</span>;
}
function birthdayLabel(value:string|null) {
  if(!value) return 'Не указан';
  const parts=value.split('-'), month=Number(parts.at(-2)), day=Number(parts.at(-1));
  const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  return day && months[month-1] ? `${day} ${months[month-1]}` : 'Не указан';
}
export function ProfileUserInfo({profile,mine,onEdit}:{profile:PublicProfile;mine:boolean;onEdit:()=>void}) {
  const links=LINKS.filter(([key])=>profile.socials?.[key]);
  return <aside className={`${card.card} ${s.info}`} aria-label="О пользователе">
    <header className={card.cardHead}><h2 className={card.cardTitle}><Icon name="paw" size={16}/>О пользователе</h2>
      {mine?<button type="button" className={card.iconBtn} aria-label="Изменить сведения о пользователе" onClick={onEdit}>✏</button>:null}</header>
    <div className={s.fact}><span aria-hidden>📅</span><div><strong>{birthdayLabel(profile.birthday)}</strong><small>День рождения</small></div></div>
    <div className={s.fact}><span aria-hidden>💸</span><div><strong>{profile.statusLabel || 'Не указана'}</strong><small>Должность на сервере</small></div></div>
    <div className={s.socials}><h3>Мои соцсети</h3>{links.length?<div className={s.links}>{links.map(([key,label])=><a key={key} href={profile.socials?.[key]} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}><SocialGlyph network={key}/></a>)}</div>:<p>Пока не указаны</p>}</div>
  </aside>;
}
