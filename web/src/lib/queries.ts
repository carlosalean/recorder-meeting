import { one, query } from "./db";

export type Client = {
  id: string; name: string; contact_name: string | null; email: string | null; phone: string | null;
  notes: string | null; project_count: number;
};
export type Project = {
  id: string; client_id: string; client_name: string; name: string; description: string | null;
  status: string; created_at: Date; updated_at: Date;
  open_topics: number; open_tasks: number; overdue_tasks: number; meeting_count: number;
  last_meeting: Date | null;
};
export type Topic = {
  id: string; project_id: string; title: string; description: string | null; status: string;
  updated_at: Date; closed_at: Date | null;
};
export type Task = {
  id: string; topic_id: string; title: string; description: string | null; owner: string | null;
  owner_person_id: string | null; due_date: string | null; status: string; updated_at: Date; closed_at: Date | null;
  last_meeting_id: string | null; last_meeting_title: string | null; overdue: boolean;
};
export type Meeting = {
  id: string; project_id: string; title: string; meeting_date: Date; source: string;
  source_path: string | null; audio_file: string | null; status: string; error: string | null;
  processed_at: Date | null; changes: number;
};
export type ChangeRow = {
  id: string; meeting_id: string | null; meeting_title: string | null; entity: string; entity_id: string;
  entity_title: string; action: string; old_status: string | null; new_status: string | null;
  note: string | null; evidence: string | null; created_at: Date; project_id: string;
};

export const listClients = () =>
  query<Client>(`
    SELECT c.*, (SELECT count(*)::int FROM projects p WHERE p.client_id = c.id) AS project_count
    FROM clients c ORDER BY lower(c.name)`);

const PROJECT_SELECT = `
  SELECT p.*, c.name AS client_name,
    (SELECT count(*)::int FROM topics t WHERE t.project_id = p.id AND t.status = 'abierto') AS open_topics,
    (SELECT count(*)::int FROM tasks k JOIN topics t ON t.id = k.topic_id
      WHERE t.project_id = p.id AND k.status NOT IN ('completada','cancelada')) AS open_tasks,
    (SELECT count(*)::int FROM tasks k JOIN topics t ON t.id = k.topic_id
      WHERE t.project_id = p.id AND k.status NOT IN ('completada','cancelada')
        AND k.due_date < current_date) AS overdue_tasks,
    (SELECT count(*)::int FROM meetings m WHERE m.project_id = p.id) AS meeting_count,
    (SELECT max(m.meeting_date) FROM meetings m WHERE m.project_id = p.id) AS last_meeting
  FROM projects p JOIN clients c ON c.id = p.client_id`;

export const listProjects = (filter: { clientId?: string; status?: string } = {}) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.clientId) where.push(`p.client_id = $${params.push(filter.clientId)}`);
  if (filter.status) where.push(`p.status = $${params.push(filter.status)}`);
  return query<Project>(
    `${PROJECT_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY p.status = 'cerrado', lower(c.name), lower(p.name)`,
    params,
  );
};

export const getProject = (id: string) =>
  one<Project & { ai_summary: string | null }>(`${PROJECT_SELECT} WHERE p.id = $1`, [id]);

const TASK_SELECT = `
  SELECT k.id, k.topic_id, k.title, k.description, COALESCE(op.name, k.owner) AS owner, k.owner_person_id,
    to_char(k.due_date, 'YYYY-MM-DD') AS due_date,
    k.status, k.updated_at, k.closed_at, k.last_meeting_id, m.title AS last_meeting_title,
    (k.due_date < current_date AND k.status NOT IN ('completada','cancelada')) AS overdue
  FROM tasks k JOIN topics t ON t.id = k.topic_id LEFT JOIN meetings m ON m.id = k.last_meeting_id
    LEFT JOIN people op ON op.id = k.owner_person_id`;

const TASK_ORDER = `ORDER BY k.status IN ('completada','cancelada'), k.due_date NULLS LAST, k.id`;

export async function getBoard(projectIds: string[], opts: { onlyOpen: boolean; owner?: string; q?: string }) {
  if (!projectIds.length) return { topics: [] as Topic[], tasks: [] as Task[] };
  const topics = await query<Topic>(
    `SELECT * FROM topics WHERE project_id = ANY($1::bigint[])
     ${opts.onlyOpen ? "AND status = 'abierto'" : ""}
     ORDER BY status = 'cerrado', updated_at DESC`,
    [projectIds],
  );
  const where = ["t.project_id = ANY($1::bigint[])"];
  const params: unknown[] = [projectIds];
  if (opts.onlyOpen) where.push("k.status NOT IN ('completada','cancelada')");
  if (opts.owner) where.push(`COALESCE(op.name, k.owner) ILIKE $${params.push(opts.owner)}`);
  if (opts.q) {
    const p = params.push(`%${opts.q}%`);
    where.push(`(k.title ILIKE $${p} OR k.description ILIKE $${p} OR t.title ILIKE $${p})`);
  }
  const tasks = await query<Task>(`${TASK_SELECT} WHERE ${where.join(" AND ")} ${TASK_ORDER}`, params);
  return { topics, tasks };
}

export const listOwners = () =>
  query<{ owner: string }>(
    `SELECT DISTINCT COALESCE(p.name, k.owner) AS owner FROM tasks k LEFT JOIN people p ON p.id = k.owner_person_id
     WHERE COALESCE(p.name, k.owner) <> '' ORDER BY 1`,
  ).then((r) => r.map((x) => x.owner));

export const listMeetings = (projectId: string) =>
  query<Meeting>(
    `SELECT m.id, m.project_id, m.title, m.meeting_date, m.source, m.source_path, m.audio_file, m.status,
       m.error, m.processed_at, (SELECT count(*)::int FROM changes c WHERE c.meeting_id = m.id) AS changes
     FROM meetings m WHERE m.project_id = $1 ORDER BY m.meeting_date DESC`,
    [projectId],
  );

export const getMeeting = (id: string) =>
  one<Meeting & { transcript: string; recorder_summary: string | null; ai_summary: string | null;
    project_name: string; client_name: string; scope_note: string | null }>(
    `SELECT m.*, p.name AS project_name, c.name AS client_name,
       (SELECT count(*)::int FROM changes x WHERE x.meeting_id = m.id) AS changes
     FROM meetings m JOIN projects p ON p.id = m.project_id JOIN clients c ON c.id = p.client_id
     WHERE m.id = $1`,
    [id],
  );

export const listChanges = (filter: { projectId?: string; meetingId?: string; limit?: number }) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) where.push(`x.project_id = $${params.push(filter.projectId)}`);
  if (filter.meetingId) where.push(`x.meeting_id = $${params.push(filter.meetingId)}`);
  return query<ChangeRow>(
    `SELECT x.*, m.title AS meeting_title FROM changes x LEFT JOIN meetings m ON m.id = x.meeting_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY x.created_at DESC, x.id DESC LIMIT ${Number(filter.limit ?? 200)}`,
    params,
  );
};

export const importedFolders = () =>
  query<{ source_path: string; id: string; project_id: string; project_name: string }>(
    `SELECT m.source_path, m.id, m.project_id, p.name AS project_name
     FROM meetings m JOIN projects p ON p.id = m.project_id WHERE m.source_path IS NOT NULL`,
  );

export const processingCount = () =>
  one<{ n: number }>("SELECT count(*)::int AS n FROM meetings WHERE status = 'procesando'").then((r) => r?.n ?? 0);

// --------------------------------------------------------------------------- Personas

export type PersonRow = {
  id: string; name: string; company: string | null; job_title: string | null; email: string | null;
  phone: string | null; notes: string | null; ai_profile: string | null; updated_at: Date;
  aliases: string[]; department: string | null; hierarchy_level: string | null; influence: string | null;
  reports_to_id: string | null; reports_to_name: string | null; linkedin: string | null;
  project_count: number; open_tasks: number; last_meeting: Date | null;
};

const PERSON_SELECT = `
  SELECT p.*,
    (SELECT b.name FROM people b WHERE b.id = p.reports_to_id) AS reports_to_name,
    (SELECT count(*)::int FROM project_people pp WHERE pp.person_id = p.id) AS project_count,
    (SELECT count(*)::int FROM tasks k WHERE k.owner_person_id = p.id
       AND k.status NOT IN ('completada','cancelada')) AS open_tasks,
    (SELECT max(m.meeting_date) FROM meeting_people mp JOIN meetings m ON m.id = mp.meeting_id
       WHERE mp.person_id = p.id) AS last_meeting
  FROM people p`;

export const listPeople = () =>
  query<PersonRow>(`${PERSON_SELECT} ORDER BY lower(coalesce(p.company, 'zzz')), lower(p.name)`);

export const getPerson = (id: string) => one<PersonRow>(`${PERSON_SELECT} WHERE p.id = $1`, [id]);

export type PersonProject = {
  project_id: string; project_name: string; project_status: string; description: string | null;
  ai_summary: string | null; client_name: string; role: string | null; summary: string | null;
};

export const personProjects = (personId: string) =>
  query<PersonProject>(
    `SELECT pr.id AS project_id, pr.name AS project_name, pr.status AS project_status, pr.description,
            pr.ai_summary, c.name AS client_name, pp.role, pp.summary
     FROM project_people pp JOIN projects pr ON pr.id = pp.project_id JOIN clients c ON c.id = pr.client_id
     WHERE pp.person_id = $1 ORDER BY pr.status = 'cerrado', pr.updated_at DESC`,
    [personId],
  );

export const personTasks = (personId: string) =>
  query<Task & { project_id: string; topic_title: string }>(
    `${TASK_SELECT.replace("SELECT k.id,", "SELECT t.project_id, t.title AS topic_title, k.id,")}
     WHERE k.owner_person_id = $1 ${TASK_ORDER}`,
    [personId],
  );

export const personMeetings = (personId: string) =>
  query<{ id: string; title: string; meeting_date: Date; project_id: string; project_name: string }>(
    `SELECT m.id, m.title, m.meeting_date, m.project_id, pr.name AS project_name
     FROM meeting_people mp JOIN meetings m ON m.id = mp.meeting_id JOIN projects pr ON pr.id = m.project_id
     WHERE mp.person_id = $1 ORDER BY m.meeting_date DESC LIMIT 50`,
    [personId],
  );

export type ProjectPerson = {
  id: string; name: string; company: string | null; job_title: string | null; role: string | null;
  summary: string | null; open_tasks: number;
};

export const projectPeople = (projectId: string) =>
  query<ProjectPerson>(
    `SELECT p.id, p.name, p.company, p.job_title, pp.role, pp.summary,
       (SELECT count(*)::int FROM tasks k JOIN topics t ON t.id = k.topic_id
         WHERE k.owner_person_id = p.id AND t.project_id = $1
           AND k.status NOT IN ('completada','cancelada')) AS open_tasks
     FROM project_people pp JOIN people p ON p.id = pp.person_id
     WHERE pp.project_id = $1 ORDER BY open_tasks DESC, lower(p.name)`,
    [projectId],
  );

export const meetingPeople = (meetingId: string) =>
  query<{ id: string; name: string; company: string | null; job_title: string | null }>(
    `SELECT p.id, p.name, p.company, p.job_title FROM meeting_people mp JOIN people p ON p.id = mp.person_id
     WHERE mp.meeting_id = $1 ORDER BY lower(p.name)`,
    [meetingId],
  );

export const personTeam = (personId: string) =>
  query<{ id: string; name: string; job_title: string | null }>(
    "SELECT id, name, job_title FROM people WHERE reports_to_id = $1 ORDER BY lower(name)", [personId]);
