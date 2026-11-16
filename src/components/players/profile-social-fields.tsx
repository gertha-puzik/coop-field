'use client';
import { Input } from '@/components/ui/input';
import type { ProfileSocials } from '@/lib/net/http-profiles';
import s from './profile-settings.module.css';
const NETWORKS=[['discord','Discord','https://discord.com/users/…'],['telegram','Telegram','https://t.me/…'],['youtube','YouTube','https://www.youtube.com/@…'],['vk','ВКонтакте','https://vk.com/…'],['website','Личный сайт','https://…']] as const;
export function ProfileSocialFields({birthday,socials,onBirthday,onSocials}:{birthday:string;socials:ProfileSocials;onBirthday:(value:string)=>void;onSocials:(value:ProfileSocials)=>void}) {
  return <div className={s.socialFields}>
    <label>День рождения<Input type="date" min="1900-01-01" max={new Date().toISOString().slice(0,10)} value={birthday} onChange={e=>onBirthday(e.target.value)}/></label>
    <h3 className={s.heading}>Соцсети и ссылки</h3>
    {NETWORKS.map(([key,label,placeholder])=><label key={key}>{label}<Input type="url" maxLength={300} placeholder={placeholder} value={socials[key] || ''} onChange={e=>onSocials({...socials,[key]:e.target.value})}/></label>)}
  </div>;
}
