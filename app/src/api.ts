// The app's bridge to the Tauri core and, through it, the machine's helper.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Event, Methods } from "./protocol.gen";

export type Machine = { id: string; label: string; host: string | null };

export type ConnectedInfo = {
  machine: Machine;
  helper_version: string;
  git_version: string;
  home: string;
};

export type WindowEvent = { type: "helper"; event: Event } | { type: "disconnected"; reason: string };

export function listMachines(): Promise<Machine[]> {
  return invoke("list_machines");
}

export function lastMachine(): Promise<string | null> {
  return invoke("last_machine");
}

export function connect(machineId: string): Promise<ConnectedInfo> {
  return invoke("connect", { machineId });
}

export function newWindow(): Promise<void> {
  return invoke("new_window");
}

/** Calls a helper method on this window's machine. */
export function call<M extends keyof Methods>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
  return invoke("request", { method, params });
}

export function onWindowEvent(handler: (event: WindowEvent) => void): () => void {
  const unlisten = getCurrentWebviewWindow().listen<WindowEvent>("gitsense", (e) => handler(e.payload));
  return () => void unlisten.then((stop) => stop());
}
