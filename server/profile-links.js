export const SOCIAL_HOSTS={discord:['discord.com','discord.gg','discordapp.com'],telegram:['t.me','telegram.me'],youtube:['youtube.com','youtu.be'],vk:['vk.com','vk.ru'],website:null};
export function cleanSocials(raw) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw)) return {};
  const out={};
  for(const [key,value] of Object.entries(raw)) {
    if(!(Object.hasOwn(SOCIAL_HOSTS,key)) || typeof value!=='string' || value.length>300) continue;
    if(!value.trim()) continue;
    try {const url=new URL(value.trim()); const host=url.hostname.toLowerCase().replace(/^www\./,'');
      if(url.protocol!=='https:' || url.username || url.password || (SOCIAL_HOSTS[key] && !SOCIAL_HOSTS[key].includes(host))) continue;
      out[key]=url.href;
    } catch {}
  }
  return out;
}
export function validSocials(raw) {
  return raw && typeof raw==='object' && !Array.isArray(raw) && Object.entries(raw).every(([key,value])=>Object.hasOwn(SOCIAL_HOSTS,key) && typeof value==='string' && (!value.trim() || !!cleanSocials({[key]:value})[key]));
}
