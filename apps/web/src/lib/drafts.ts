import { useSyncExternalStore } from 'react';

// Brouillons par discussion : gardés en mémoire et dans le navigateur
// (localStorage, best-effort), jamais envoyés au serveur.
const STORAGE_KEY = 'wa-bridge.drafts';
const MAX_DRAFT = 10_000;

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let drafts: Record<string, string> = load();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    /* stockage indisponible : le brouillon reste en mémoire */
  }
}

export function draftKey(accountId: string, jid: string): string {
  return `${accountId}|${jid}`;
}

export function getDraft(key: string): string {
  return drafts[key] ?? '';
}

export function setDraft(key: string, text: string): void {
  const value = text.slice(0, MAX_DRAFT);
  if ((drafts[key] ?? '') === value) return;
  const next = { ...drafts };
  if (value.trim()) next[key] = value;
  else delete next[key];
  drafts = next;
  persist();
  listeners.forEach((l) => l());
}

// Efface tous les brouillons (mémoire + navigateur) : appelé dès que
// l'application n'est plus authentifiée (déconnexion, session expirée), pour
// ne pas laisser de textes privés dans le navigateur.
export function clearDrafts(): void {
  drafts = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* rien à faire */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Tous les brouillons (réactif) : pour l'aperçu « Brouillon : » de la liste.
export function useDrafts(): Record<string, string> {
  return useSyncExternalStore(subscribe, () => drafts);
}
