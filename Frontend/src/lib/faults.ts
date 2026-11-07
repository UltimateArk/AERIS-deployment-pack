export type Severity = "Critical" | "High" | "Med-High" | "Med" | "Low";

export const SEVERITY_RANK: Record<Severity, number> = {
  Critical: 4,
  High: 3,
  "Med-High": 2,
  Med: 1,
  Low: 0,
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  Critical: "var(--color-crit)",
  High: "var(--color-crit)",
  "Med-High": "var(--color-caution)",
  Med: "var(--color-caution)",
  Low: "var(--color-ok)",
};

export interface FaultDef {
  id: string;
  name: string;
  severity: Severity;
  origin: string;
  location: string;
  validate: string;
  reason: string;
  rulImpact: string;
  action: string;
  confidence: number;
  horizon: "Current" | "Future";
  // Telemetry channels this fault perturbs.
  affects: string[];
}

export const FAULTS: FaultDef[] = [
  {
    id: "1",
    name: "Misfire",
    severity: "High",
    origin: "Cyl #3 ignition",
    location: "Ignition harness, coil pack B",
    validate: "EGT3 −85°C vs bank avg; RPM ripple 4.2%",
    reason: "Intermittent spark event on cylinder 3 detected via EGT depression and crank-speed variance.",
    rulImpact: "−13 hrs",
    action: "Inspect coil pack B, plug gap & harness continuity.",
    confidence: 88,
    horizon: "Current",
    affects: ["egt3", "rpm", "powerKw"],
  },
  {
    id: "2",
    name: "Injector Clog",
    severity: "Med-High",
    origin: "Fuel injector #2",
    location: "Port injector rail, station 2",
    validate: "Fuel flow −6.1%; EGT2 −40°C",
    reason: "Partial obstruction reducing atomized delivery; lean bias observed on cyl 2.",
    rulImpact: "−9 hrs",
    action: "Run cleaning cycle; if persistent, replace injector #2.",
    confidence: 74,
    horizon: "Current",
    affects: ["fuelFlow", "egt2"],
  },
  {
    id: "3",
    name: "Fuel Pump",
    severity: "Med-High",
    origin: "HP fuel pump",
    location: "Engine-driven pump, delivery line",
    validate: "MAP −3.5 kPa under load; fuel flow noise +11%",
    reason: "Delivery pressure instability under high demand consistent with impeller wear.",
    rulImpact: "−10 hrs",
    action: "Verify supply pressure; schedule pump overhaul.",
    confidence: 69,
    horizon: "Future",
    affects: ["map", "fuelFlow"],
  },
  {
    id: "4",
    name: "Oil Low",
    severity: "Critical",
    origin: "Lubrication circuit",
    location: "Sump / oil gallery",
    validate: "Oil press −1.8 bar; oil temp +22°C",
    reason: "Oil pressure below floor with rising temperature — imminent bearing starvation risk.",
    rulImpact: "−30 hrs",
    action: "Reduce power NOW. Land ASAP. Check level & leaks.",
    confidence: 93,
    horizon: "Current",
    affects: ["oilPressure", "oilTemp"],
  },
  {
    id: "5",
    name: "Bearing Wear",
    severity: "High",
    origin: "Main crank bearing",
    location: "Journal #2",
    validate: "vibRMS +2.9 mm/s; VibY dominant 1×",
    reason: "Rising 1× vibration amplitude and RMS trend consistent with journal clearance growth.",
    rulImpact: "−16 hrs",
    action: "Trend-monitor; plan bottom-end inspection.",
    confidence: 81,
    horizon: "Future",
    affects: ["vibY", "vibRMS", "vibX"],
  },
  {
    id: "6",
    name: "Low Compression",
    severity: "Med",
    origin: "Cyl #1 sealing",
    location: "Ring pack / valve seat, cyl 1",
    validate: "Power −4.2 kW; CHT1 −18°C; RPM ripple 2.1%",
    reason: "Reduced combustion pressure on cyl 1 indicating ring or valve leakage.",
    rulImpact: "−8 hrs",
    action: "Leak-down test cyl 1; assess ring/valve.",
    confidence: 66,
    horizon: "Future",
    affects: ["powerKw", "cht"],
  },
  {
    id: "7",
    name: "Cooling Fail",
    severity: "High",
    origin: "Cooling airflow",
    location: "Cowl flap / cylinder fins",
    validate: "CHT +34°C trend; oil temp +14°C",
    reason: "Insufficient heat rejection driving cylinder-head temperatures upward.",
    rulImpact: "−15 hrs",
    action: "Open cowl flaps, reduce load, inspect baffling.",
    confidence: 79,
    horizon: "Current",
    affects: ["cht", "oilTemp"],
  },
  {
    id: "8",
    name: "Overheat",
    severity: "High",
    origin: "Combustion thermal",
    location: "All cylinders, head zone",
    validate: "CHT +48°C; EGT avg +60°C",
    reason: "Broad thermal excursion across cylinders exceeding envelope limits.",
    rulImpact: "−17 hrs",
    action: "Enrich mixture, reduce power, increase cooling.",
    confidence: 84,
    horizon: "Current",
    affects: ["cht", "egt", "egt1", "egt2", "egt3", "egt4"],
  },
  {
    id: "9",
    name: "Knock",
    severity: "Critical",
    origin: "Detonation",
    location: "Cyl #2 & #4 combustion",
    validate: "VibX high-freq +5.4 mm/s; CHT +26°C",
    reason: "Abnormal combustion / detonation signature on knock sensor band.",
    rulImpact: "−28 hrs",
    action: "Retard timing, enrich mixture, reduce MAP immediately.",
    confidence: 91,
    horizon: "Current",
    affects: ["vibX", "vibRMS", "cht"],
  },
  {
    id: "10",
    name: "Injection Timing",
    severity: "Med",
    origin: "Injection scheduler",
    location: "ECU timing map",
    validate: "Inj timing +2.6° drift",
    reason: "Commanded vs actual injection phase drift degrading efficiency.",
    rulImpact: "−6 hrs",
    action: "Recalibrate timing map; verify cam/crank sensors.",
    confidence: 63,
    horizon: "Future",
    affects: ["injTiming"],
  },
  {
    id: "11",
    name: "Back Press",
    severity: "Med",
    origin: "Exhaust restriction",
    location: "Exhaust manifold / muffler",
    validate: "EGT avg +22°C; power −2.7 kW",
    reason: "Elevated exhaust back-pressure reducing scavenging efficiency.",
    rulImpact: "−5 hrs",
    action: "Inspect exhaust for restriction / carbon buildup.",
    confidence: 61,
    horizon: "Future",
    affects: ["egt", "powerKw"],
  },
  {
    id: "12",
    name: "Alt Fail",
    severity: "Med",
    origin: "Alternator",
    location: "Charging circuit",
    validate: "BattV −1.4 V; AltA −6.2 A",
    reason: "Charging output declining; bus voltage trending toward battery-only ops.",
    rulImpact: "−7 hrs",
    action: "Shed non-essential loads; inspect alternator/belt.",
    confidence: 72,
    horizon: "Current",
    affects: ["battV", "altA"],
  },
  {
    id: "13",
    name: "Sensor Drift",
    severity: "Low",
    origin: "EGT thermocouple",
    location: "EGT probe, cyl 4",
    validate: "EGT4 slow bias +0.6°C/min",
    reason: "Slow monotonic bias inconsistent with combustion physics — sensor drift suspected.",
    rulImpact: "−2 hrs",
    action: "Cross-check with bank; recalibrate/replace probe.",
    confidence: 58,
    horizon: "Future",
    affects: ["egt4"],
  },
  {
    id: "14",
    name: "EGT Imbalance",
    severity: "Med",
    origin: "Fuel distribution",
    location: "Intake manifold balance",
    validate: "EGT spread +72°C across bank",
    reason: "Widened exhaust-gas-temp spread indicating uneven cylinder fueling.",
    rulImpact: "−5 hrs",
    action: "Balance injectors; inspect intake for air leak.",
    confidence: 67,
    horizon: "Current",
    affects: ["egtSpread", "egt1", "egt4"],
  },
];

export const FAULT_BY_ID: Record<string, FaultDef> = Object.fromEntries(
  FAULTS.map((f) => [f.id, f]),
);

// One fault per subsystem group. Codes 6 and 11 conflict. Code 13 stacks.
const FAULT_GROUPS: Record<string, string> = {
  1: "comb", 9: "comb", 10: "comb", 14: "comb",
  2: "fuel", 3: "fuel",
  4: "mech", 5: "mech", 6: "mech",
  7: "heat", 8: "heat", 11: "heat",
  12: "elec",
  13: "sensor",
};

export function conflictsWith(id: string, active: string[]): string | null {
  if (id === "13") return null; // sensor stacks
  for (const a of active) {
    if (a === "13") continue;
    if (FAULT_GROUPS[a] === FAULT_GROUPS[id]) return FAULT_BY_ID[a].name;
  }
  if ((id === "6" && active.includes("11")) || (id === "11" && active.includes("6"))) {
    return FAULT_BY_ID[id === "6" ? "11" : "6"].name;
  }
  return null;
}

export const MAX_ACTIVE = 3;
