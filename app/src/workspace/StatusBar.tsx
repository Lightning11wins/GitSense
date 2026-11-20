import { X } from "lucide-react";
import { useSession, type Session } from "./session";

export function StatusBar({ session }: { session: Session }) {
  const info = useSession(session, (s) => s.info);
  const notices = useSession(session, (s) => s.notices);
  const reposLoading = useSession(session, (s) => s.reposLoading);
  const notice = notices.at(-1);
  return (
    <div className="status-bar">
      {reposLoading && <span>Scanning for repositories...</span>}
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
