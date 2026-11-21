import { X } from "lucide-react";
import { useSession, type CenterTab, type Session } from "./session";
import { DiffView } from "./DiffView";
import { PushView } from "./PushView";
import { MergeTool } from "../merge/MergeTool";
import { baseName } from "./repos";
import "./CenterTabs.css";

/** The center editor area: tabs for diffs and pushes. */
export function CenterTabs({ session }: { session: Session }) {
  const tabs = useSession(session, (s) => s.tabs);
  const active = useSession(session, (s) => s.activeTab);
  if (tabs.length === 0) return <div className="center-empty secondary">Double-click a change to see its diff</div>;
  return (
    <>
      <div className="center-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`center-tab ${tab.id === active ? "active" : ""}`}
            title={tabTitle(tab)}
            onMouseDown={(e) => (e.button === 1 ? session.closeTab(tab.id) : session.activateTab(tab.id))}
          >
            <span>{tab.kind === "diff" ? baseName(tab.right.path) : tab.kind === "merge" ? `Merge ${baseName(tab.path)}` : "Push"}</span>
            <button
              className="center-tab-close"
              title="Close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => session.closeTab(tab.id)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} className="center-content" hidden={tab.id !== active}>
          {tab.kind === "diff" ? (
            <DiffView session={session} tab={tab} />
          ) : tab.kind === "merge" ? (
            <MergeTool session={session} tab={tab} />
          ) : (
            <PushView session={session} tab={tab} />
          )}
        </div>
      ))}
    </>
  );
}

function tabTitle(tab: CenterTab) {
  if (tab.kind === "diff") return `${tab.repo}/${tab.right.path}`;
  if (tab.kind === "merge") return `Merge ${tab.repo}/${tab.path}`;
  return "Push Commits";
}
