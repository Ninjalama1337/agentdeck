import { nanoid } from 'nanoid';

/** Short prefixed id, e.g. `p_V1StGXR8_Z5j`. */
export function newId(prefix: string): string {
  return `${prefix}_${nanoid(12)}`;
}

export const newProjectId = () => newId('p');
export const newSessionId = () => newId('s');
export const newMessageId = () => newId('m');
export const newDeviceId = () => newId('d');
export const newFileId = () => newId('f');
export const newTeamRunId = () => newId('t');
export const newStepId = () => newId('st');
export const newAdminJobId = () => newId('j');
export const newTerminalId = () => newId('t');
export const newRoutineId = () => newId('r');
export const newAccountId = () => newId('acc');
