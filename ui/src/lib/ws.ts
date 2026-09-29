import type { Me } from "../types";

/** Links into the Databricks workspace, for "open where this lives" buttons. */
export const volumeUrl = (me: Me | null, path: string, isDir = false) => {
  if (!me) return undefined;
  const m = path.match(/^\/Volumes\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m) return undefined;
  const rest = m[4] ?? "/";
  const dir = isDir ? rest.replace(/\/?$/, "/") : rest.replace(/[^/]*$/, "");
  return `${me.host.replace(/\/$/, "")}/explore/data/volumes/${m[1]}/${m[2]}/${m[3]}?volumePath=${encodeURIComponent(`/Volumes/${m[1]}/${m[2]}/${m[3]}${dir}`)}`;
};
export const tableUrl = (me: Me | null, table: string) => (me ? `${me.host.replace(/\/$/, "")}/explore/data/${me.catalog}/${me.schema}/${table}` : undefined);
export const workspacePath = (me: Me | null, sub: string) => (me ? `/Volumes/${me.catalog}/${me.schema}/workspace/${sub}` : "");
