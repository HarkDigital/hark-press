import type { ChapterDef } from '../core/types'

/**
 * The print run, in order. `length` is scroll distance in viewport heights;
 * `landing` is where nav jumps land (local progress). Each chapter lives in
 * src/chapters/<id>/ and default-exports a factory returning a Chapter.
 */
export const CHAPTERS: ChapterDef[] = [
  { id: 'hero', label: 'Proof', length: 2.6, landing: 0, load: () => import('./hero/index') },
  { id: 'work', label: 'Paste-up', length: 3.8, landing: 0.12, load: () => import('./work/index') },
  { id: 'services', label: 'Type Case', length: 3.6, landing: 0.08, load: () => import('./services/index') },
  { id: 'voices', label: 'Zine', length: 3.0, landing: 0.06, load: () => import('./voices/index') },
  { id: 'shield', label: 'Shredder', length: 1.6, landing: 0.45, load: () => import('./shield/index') },
  { id: 'process', label: 'Fold', length: 1.9, landing: 0.19, load: () => import('./process/index') },
  { id: 'contact', label: 'Airmail', length: 1.5, landing: 0.3, load: () => import('./contact/index') },
]
