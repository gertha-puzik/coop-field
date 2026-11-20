"use client";

import { useEffect, useRef } from 'react';
import type { DayPart, WeatherKind } from '@/lib/sim/settings';
import styles from './weather-hud.module.css';

const width = 300;
const height = 150;
const times = { morning: 'Утро', day: 'День', evening: 'Вечер', night: 'Ночь' };
const weatherArt = {
  sun: { icon: 'weathersun', label: 'Солнечно' },
  cloud: { icon: 'weathercloudy', label: 'Облачно' },
  rain: { icon: 'weatherrain', label: 'Дождь' },
};
const images = new Map<string, Promise<HTMLImageElement>>();

function loadLayer(name: string) {
  const cached = images.get(name);
  if (cached) return cached;
  const image = new Image();
  image.src = `/ui/weather-hud/${name}.png`;
  const decoded = image.decode().then(() => image).catch((error: unknown) => {
    images.delete(name);
    throw error;
  });
  images.set(name, decoded);
  return decoded;
}

function WeatherPicture({ phase, weather }: { phase: DayPart; weather: WeatherKind }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const composed = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext('2d');
    if (!node || !context) return;
    let current = true;
    function paint() {
      const source = composed.current;
      if (!source || !node || !context) return;
      const rect = node.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (w < 1 || h < 1) return;
      if (node.width !== w) node.width = w;
      if (node.height !== h) node.height = h;
      context.clearRect(0, 0, w, h);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, w, h);
    }
    const observer = new ResizeObserver(paint);
    observer.observe(node);
    window.addEventListener('resize', paint);
    void Promise.all([
      loadLayer('maintheme'), loadLayer(phase),
      loadLayer(weather === 'rain' ? 'mainthememiniRAIN' : 'mainthememini'),
      loadLayer(weatherArt[weather].icon),
    ]).then(layers => {
      if (!current) return;
      const source = document.createElement('canvas');
      source.width = width;
      source.height = height;
      const sourceContext = source.getContext('2d');
      if (!sourceContext) return;
      for (const layer of layers) sourceContext.drawImage(layer, 0, 0);
      composed.current = source;
      paint();
    }).catch(() => { /* Keep the previous complete frame if loading fails. */ });
    return () => {
      current = false;
      observer.disconnect();
      window.removeEventListener('resize', paint);
    };
  }, [phase, weather]);

  return <canvas className={styles.picture} ref={canvas} aria-hidden="true" />;
}

export function WeatherHud({ phase, weather, location }: {
  phase: DayPart;
  weather: WeatherKind;
  location: string;
}) {
  return (
    <div className={styles.hud} role="group" aria-label={`Погода и время суток · ${times[phase]}`}>
      <WeatherPicture phase={phase} weather={weather} />
      <span className={styles.location} aria-label={`Текущая локация · ${location}`}>{location}</span>
      <span className={styles.weather}>{weatherArt[weather].label}</span>
    </div>
  );
}
