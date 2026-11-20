import { LoaderCircle, X } from "lucide-react";
import { useSession, type Session } from "./session";

export function StatusBar({ session }: { session: Session }) {
  const info = useSession(session, (s) => s.info);
  const notices = useSession(session, (s) => s.notices);
  const reposLoading = useSession(session, (s) => s.reposLoading);
  const tasks = useSession(session, (s) => s.tasks);
  const notice = notices.at(-1);
  return (
    <div className="status-bar">
      {reposLoading && <span>Scanning for repositories...</span>}
      {tasks.length > 0 && (
        <span className="task" title={tasks.map((t) => t.label).join("\n")}>
          <LoaderCircle size={12} className="spin" />
          {tasks[0].label}
          {tasks.length > 1 && <span className="secondary"> (+{tasks.length - 1} more)</span>}
        </span>
      )}
      {notice && (
        <span title={notice}>
          {notice}{" "}
          <button className="icon-button" style={{ width: 18, height: 18 }} onClick={() => session.dismissNotice(notices.length - 1)}>
            <X size={12} />
          </button>
        </span>
      )}
      <span className="spacer" />
      <span>
        {info.machine.label} · git {info.git_version}
      </span>
    </div>
  );
}
