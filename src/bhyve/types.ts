/**
 * Shapes of the (unofficial) Orbit B-hyve cloud API.
 * Based on community reverse engineering (pybhyve / bhyve-home-assistant); only the fields we use
 * are typed, and everything is optional-tolerant because Orbit can change it without notice.
 */

export interface BhyveSession {
  orbit_session_token: string;
  user_id: string;
}

export interface BhyveZone {
  station: number;
  name?: string;
  [key: string]: unknown;
}

export interface BhyveDeviceStatus {
  run_mode?: 'auto' | 'manual' | 'off' | string;
  rain_delay?: number;
  watering_status?: {
    current_station?: number;
    started_watering_station_at?: string;
    stations?: { station: number; run_time: number }[];
  } | null;
  [key: string]: unknown;
}

export interface BhyveDevice {
  id: string;
  name: string;
  /** e.g. "sprinkler_timer" for controllers/hose timers, "bridge" for the Wi-Fi hub. */
  type: string;
  hardware_version?: string;
  firmware_version?: string;
  is_connected?: boolean;
  num_stations?: number;
  zones?: BhyveZone[];
  status?: BhyveDeviceStatus;
  battery?: { percent?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface BhyveProgram {
  id: string;
  device_id: string;
  name?: string;
  program?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** Messages received on the events WebSocket. `event` is the discriminator. */
export interface BhyveEvent {
  event: string;
  device_id?: string;
  [key: string]: unknown;
}

export interface StationRun {
  /** Zone/station number as shown in `zones[].station`. */
  station: number;
  /** Minutes. */
  runTime: number;
}
