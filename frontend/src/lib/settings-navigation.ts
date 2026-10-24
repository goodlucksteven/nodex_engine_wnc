import { Blocks, BookOpen, KeyRound, RadioTower, ShieldCheck, SlidersHorizontal, Wallet } from "lucide-react";

export type SettingsSection = "wallet" | "networks" | "connections" | "logs" | "secrets" | "privacy" | "security";

export const SETTINGS_ITEMS = [
  { id: "wallet", title: "Wallet", description: "Wallet name and ID", icon: Wallet },
  { id: "networks", title: "Networks", description: "Chains and addresses", icon: Blocks },
  { id: "connections", title: "Connections", description: "Stream and API keys", icon: RadioTower },
  { id: "logs", title: "Logs", description: "Requests and errors", icon: BookOpen },
  { id: "secrets", title: "Secrets", description: "Saved API keys", icon: KeyRound },
  { id: "privacy", title: "Privacy", description: "Balance visibility", icon: SlidersHorizontal },
  { id: "security", title: "Security", description: "PIN and recovery", icon: ShieldCheck },
] as const;

export const SETTINGS_SECTION_SELECT_EVENT = "nodex-settings-section-select";
export const SETTINGS_SECTION_ACTIVE_EVENT = "nodex-settings-section-active";
