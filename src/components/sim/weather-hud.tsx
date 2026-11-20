import type { RefObject } from 'react';
import type { DayPart, WeatherKind } from '@/lib/sim/settings';
import styles from './weather-hud.module.css';

const times = { morning: 'Утро', day: 'День', evening: 'Вечер', night: 'Ночь' };
const weatherArt = {
  sun: { icon: '☀️', label: 'Солнечно' },
  cloud: { icon: '☁️', label: 'Облачно' },
  rain: { icon: '🌧️', label: 'Дождь' },
};

export function WeatherHud({ phase, weather, location, dialRef }: {
  phase: DayPart;
  weather: WeatherKind;
  location: string;
  dialRef: RefObject<HTMLCanvasElement | null>;
}) {
  const current = weatherArt[weather];
  return (
    <div className={styles.hud} role="group" aria-label={`Погода и время суток · ${times[phase]}`}>
      <div className={styles.location}>
        <span className={styles.pin} aria-hidden="true" />
        <span className={styles.place}>{location}</span>
      </div>
      <canvas className={styles.dial} ref={dialRef} aria-hidden="true" />
      <div className={styles.weather}>
        <span className={styles.weatherIcon} aria-hidden="true">{current.icon}</span>
        <span className={styles.weatherLabel}>{current.label}</span>
      </div>
    </div>
  );
}
