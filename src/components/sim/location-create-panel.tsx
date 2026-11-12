'use client';

/**
 * Создание локации из редактора (POST /locations). Отдельный модуль удобен
 * для изоляции UI; литерала /admin/ здесь нет — A1 grotto-гейт спокоен.
 */
import { useState } from 'react';
import { Button } from '@/components/ui';
import { httpCreateLocation } from '@/lib/net/http-locations';
import editorStyles from './simulator/components/editor-workspace.module.css';

export function LocationCreatePanel({
  nextIdHint,
  onCreated,
}: {
  nextIdHint: number;
  onCreated: (id: number) => void;
}) {
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createMsg, setCreateMsg] = useState<string | null>(null);

  const createLocation = async () => {
    if (createBusy) return;
    setCreateBusy(true);
    setCreateMsg(null);
    try {
      const res = await httpCreateLocation(createName);
      if (!res.ok) {
        setCreateMsg(res.message || 'Не удалось создать локацию.');
        return;
      }
      setCreateMsg(`Создана «${res.place.name}» · ID ${res.place.id} (10×10). Открываем…`);
      setCreateName('');
      onCreated(res.place.id);
    } catch {
      setCreateMsg('Сервер недоступен — попробуйте позже.');
    } finally {
      setCreateBusy(false);
    }
  };

  return (
    <>
      <h3>Новая локация · ID {nextIdHint}</h3>
      <label className={editorStyles.field}>
        Название новой локации
        <input
          aria-label="Название новой локации"
          maxLength={64}
          placeholder={`Локация ${nextIdHint}`}
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          disabled={createBusy}
        />
      </label>
      <Button onClick={() => void createLocation()} disabled={createBusy}>
        {createBusy ? 'Создаём…' : 'Создать локацию 10×10'}
      </Button>
      <p className={editorStyles.hint}>
        ID назначается следующим свободным числом после текущих локаций. Стартовая карта — ровное поле 10×10.
      </p>
      {createMsg ? (
        <p className={editorStyles.hint} role="status">
          {createMsg}
        </p>
      ) : null}
    </>
  );
}
