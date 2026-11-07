export type DirectoryDepartment = { externalId: string; name: string; parentExternalId?: string | null; };
export type DirectoryPerson = {
  externalId: string; stableId?: string; name: string; email?: string; phone?: string;
  avatarUrl?: string; departmentIds: string[]; disabled?: boolean; providerData?: Record<string, unknown>;
};
export type DirectorySnapshot = { departments: DirectoryDepartment[]; people: DirectoryPerson[] };
export interface DirectoryProvider {
  read(includePeople?: boolean): Promise<DirectorySnapshot>;
  test(): Promise<unknown>;
}

export type { SyncOptions,SyncScope } from "./sync-contract.js";
