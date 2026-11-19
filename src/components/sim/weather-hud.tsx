import type { DayPart, WeatherKind } from '@/lib/sim/settings';
import styles from './weather-hud.module.css';

const assets = '/ui/weather-hud/';
const times = {
  morning: 'Утро',
  day: 'День',
  evening: 'Вечер',
  night: 'Ночь',
};
const weatherArt = {
  sun: { icon: 'weathersun', label: 'Солнечно' },
  cloud: { icon: 'weathercloudy', label: 'Облачно' },
  rain: { icon: 'weatherrain', label: 'Дождь' },
};

function Layer({ name, active = true }: { name: string; active?: boolean }) {
  return <img className={styles.layer} src={`${assets}${name}.png`} alt=""
    width={300} height={150} draggable={false} data-active={active} />;
}

export function WeatherHud({ phase, weather, location }: {
  phase: DayPart;
  weather: WeatherKind;
  location: string;
}) {
  return (
    <div className={styles.hud} role="group" aria-label={`Погода и время суток · ${times[phase]}`}>
      <Layer name="maintheme" />
      {/* All four frames share a registration point. Keep them loaded for instant swaps. */}
      {Object.keys(times).map(time => <Layer key={time} name={time} active={phase === time} />)}
      <Layer name="mainthememini" active={weather !== 'rain'} />
      <Layer name="mainthememiniRAIN" active={weather === 'rain'} />
      {Object.entries(weatherArt).map(([kind, art]) =>
        <Layer key={kind} name={art.icon} active={weather === kind} />)}
      <span className={styles.location} aria-label={`Текущая локация · ${location}`}>{location}</span>
      <span className={styles.weather}>{weatherArt[weather].label}</span>
    </div>
  );
}
