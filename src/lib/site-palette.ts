export const SITE_PALETTE_DEFAULTS = {
  'button-idle': '#25203d',
  'button-idle-text': '#f4f0ff',
  'button-active': '#725738',
  'button-active-text': '#fff2d4',
  'button-disabled': '#343047',
  'button-disabled-text': '#b9b3d9',
  header: '#31283d',
  navigation: '#2b233c',
  cards: '#211b36',
  inset: '#17142a',
  dialog: '#1e1831',
  scrim: '#080713',
  'form-field': '#181529',
  game: '#2a2033',
} as const;

export type SitePaletteKey = keyof typeof SITE_PALETTE_DEFAULTS;
export type SitePalette = Partial<Record<SitePaletteKey,string>>;

export function resolveSitePalette(palette: SitePalette): SitePalette {
  const result = {...palette};
  for (const state of ['idle','active','disabled'] as const) {
    const color = palette[`button-${state}`];
    const ink = `button-${state}-text` as const;
    if (!color || palette[ink]) continue;
    const channels = [1,3,5].map(i=>{
      const channel = Number.parseInt(color.slice(i,i+2),16)/255;
      return channel <= .04045 ? channel/12.92 : ((channel+.055)/1.055)**2.4;
    });
    const luminance = channels[0]*.2126 + channels[1]*.7152 + channels[2]*.0722;
    result[ink] = luminance > .179 ? '#000000' : '#ffffff';
  }
  return result;
}
