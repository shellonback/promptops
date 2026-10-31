import { RoleInterface } from "@core/interfaces/role.interface";
import { FormGroup } from "@angular/forms";
import { UserInterface } from "@core/interfaces/user.interface";

export interface UiPreferences {
  theme?: 'light' | 'dark' | 'system';
  // Manual UI style override — wins over the A/B default (ui_version).
  ui_style?: 'classic' | 'minimal';
  font_family?: string;
  font_size?: number;
  terminal_font_family?: string;
  terminal_font_size?: number;
  terminal_cursor_style?: 'block' | 'underline' | 'bar';
  terminal_line_height?: number;
  // Terminal performance toggles (default on). Let users trade a feature for
  // raw responsiveness on slower machines (notably Windows).
  terminal_gpu_acceleration?: boolean; // WebGL renderer vs DOM renderer
  terminal_link_detection?: boolean;   // file/URL link detection on output
  terminal_cursor_blink?: boolean;     // blinking cursor (continuous repaint)
  // Background "tail" detection (desktop native side) — regex scanning per
  // output chunk. Disabling trades the feature for raw terminal throughput.
  terminal_command_detection?: boolean;  // smart-action / command pattern matching
  terminal_input_detection?: boolean;    // detect when the agent asks for input
  terminal_activity_tail?: boolean;      // tail-file pipeline (auto-approve / idle)
  // Windows-only "Safe terminal" master switch. When on (Windows only), PromptOps
  // disables ALL its terminal background work — detection pipeline, tailer poll,
  // post-switch reflow nudge and git-status polling — so the user can confirm
  // whether our software is the cause of the Windows lag. Inert on macOS/Linux.
  terminal_safe_mode?: boolean;
  // Desktop v2: terminal screens kept by the app (host VT state). Switching
  // sessions repaints from that exact picture instead of replaying raw output.
  terminal_host_screen?: boolean;
  // Desktop v2 (beta): agents run in the separate terminal host (termd), so a
  // crash or an update restart of the app does not stop them.
  terminal_persistent_agents?: boolean;
  // Windows-only default terminal shell for NEW sessions
  // ('powershell' | 'pwsh' | 'cmd' | 'gitbash' | 'wsl:<distro>').
  // Device-specific (the shell roster differs per machine) → localStorage.
  terminal_default_shell?: string;
  sidebar_size?: string;
}

export class User {
  id?: number;
  first_name?: string;
  last_name?: string;
  email?: string;
  username?: string;
  email_verified_at?: string | null;
  tos?: boolean;
  tos_edited_at?: string | null;
  privacy?: boolean;
  privacy_edited_at?: string | null;
  active?: boolean;
  is_guest?: boolean;
  created_at?: string;
  updated_at?: string;
  roleId?: number;
  role?: RoleInterface;
  provider?: string | null;
  provider_id?: string | null;
  password?: string | null;
  password_confirmation?: string | null;
  bio?: string | null;
  avatar?: string | null;
  avatar_url?: string | null;
  full_name?: string;
  location?: string | null;
  website?: string | null;
  github_username?: string | null;
  nationality?: string | null;
  hours?: number | null;
  is_pro?: boolean;
  pro_expires_at?: string;
  pro_remaining_days?: number;
  platforms_list?: string[];
  desktop_app_version?: string | null;
  prompts_count?: number;
  prompts_this_month?: number;
  email_notifications_enabled?: boolean;
  marketing_emails_enabled?: boolean;
  product_updates_enabled?: boolean;
  ui_preferences?: UiPreferences | null;
  // 1 = classic UI, 2 = new (minimal) UI. The local profile is always 2.
  ui_version?: number;
  ui_usage_minutes?: number;
  consent_accepted_at?: string | null;
  consent_version?: string | null;
  onboarding_completed_at?: string | null;
  onboarding_interest?: 'sessions' | 'prompts' | 'teams' | 'explore' | null;
  preferred_provider?: string | null;
  last_seen_at?: string | null;

  static generateModel(form: FormGroup<UserInterface>, user?: User): User {
    const formValues = form.getRawValue();
    const selectedRole = formValues.role as RoleInterface | null;

    const payload: any = {
      ...formValues,
      ...(user?.id ? { id: user.id } : {}),
    };

    if (selectedRole && selectedRole.id) {
      payload.role_id = selectedRole.id;
    } else if (user?.role?.id) {
      payload.role_id = user.role.id;
    }

    delete payload.role;

    if (user?.id) {
      delete payload.password;
      delete payload.password_confirmation;
    }

    return payload as unknown as User;
  }
}
