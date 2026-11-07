import type { AtsName } from '../domain.js';
import type { AtsAdapter, BoardAdapter } from './types.js';
import { ashby } from './ats/ashby.js';
import { greenhouse } from './ats/greenhouse.js';
import { lever } from './ats/lever.js';
import { recruitee } from './ats/recruitee.js';
import { jobicy } from './boards/jobicy.js';
import { remoteok } from './boards/remoteok.js';
import { wwr } from './boards/wwr.js';
import { arbeitnow } from './boards/arbeitnow.js';
import { hn } from './boards/hn.js';

export const boardAdapters: BoardAdapter[] = [jobicy, remoteok, wwr, arbeitnow, hn];
export const atsAdapters: Record<AtsName, AtsAdapter> = { ashby, greenhouse, lever, recruitee };
