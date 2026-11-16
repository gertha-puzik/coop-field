import { apiFetch, asText } from './http-auth';
export const PERMISSION_LABELS:Record<string,string>={overview:'Общее и журнал',players:'Игроки и удаление',roles:'Роли доступа',world:'Мир и телепортация',config:'Настройки мира и броня',sprites:'Спрайты',textures:'Текстуры и оформление сайта',invites:'Коды приглашений',news:'Новостная доска',announcements:'Объявления',statuses:'Косметические статусы'};
export const AUDIT_LABELS:Record<string,string>={'location-updates':'Локации',statuses:'Статусы',registrations:'Регистрации',sprites:'Спрайты',textures:'Текстуры',invites:'Приглашения',news:'Новостная доска',announcements:'Объявления',roles:'Роли доступа',players:'Игроки'};
export type ConsoleRole={id:string;name:string;permissions:string[]};
export type ConsoleUser={accountId:string;login:string;displayName:string;statusLabel:string;statusId:string;accessRoleId:string;permissions:string[];presence:string;avatar:string|null};
export type AuditItem={id:string;at:number;group:string;text:string;actor:string};
export async function consoleRequest<T>(path='',method='GET',body?:unknown):Promise<({ok:true}&T)|{ok:false;reason:string}> {
  const {status,row}=await apiFetch(`/cfg/console${path}`,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
  return status>=200 && status<300 && row?.ok===true ? row as unknown as {ok:true}&T : {ok:false,reason:asText(row?.reason,'offline')};
}
export function consoleError(reason:string) {
  const messages:Record<string,string>={forbidden:'Нет прав для этого действия.',auth_required:'Войдите в аккаунт.',protected:'Защищённый аккаунт или действие. Себя изменить нельзя.',bad_password:'Неверный специальный пароль.',rate:'Слишком много попыток — подождите минуту.',not_found:'Запись не найдена.',invalid:'Проверьте название и права роли.',invalid_spawn:'Выберите точку спавна.',spawn_unavailable:'Точка спавна занята или заблокирована.',not_on_field:'Игрок уже вышел с поля.',invalid_request:'Не удалось выполнить запрос.'};
  return messages[reason] || `Не удалось выполнить действие (${reason}).`;
}
