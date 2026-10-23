// T3's device tools panel (docs/plans/preview.md, D1333), derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/device/DeviceToolsPanel.tsx (its sections,
// rows, choices and copy) and useDeviceControls.ts (reading the settings and acting, one at a time).
import type {
  DeviceAction,
  DeviceDetail,
  DevicePermission,
  DeviceSummary,
  DeviceTextSize,
} from "@jhin/preview-api";
import {
  Button,
  Input,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  cn,
} from "@jhin/ui";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

const TEXT_SIZES: ReadonlyArray<{ value: DeviceTextSize; label: string }> = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "extra-large", label: "Extra large" },
];

const COLOR_FILTERS = [
  { value: "none", label: "None" },
  { value: "grayscale", label: "Grayscale" },
  { value: "red-green", label: "Red / green (protanopia)" },
  { value: "green-red", label: "Green / red (deuteranopia)" },
  { value: "blue-yellow", label: "Blue / yellow (tritanopia)" },
] as const;

const ORIENTATIONS = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape_left", label: "Landscape left" },
  { value: "portrait_upside_down", label: "Upside down" },
  { value: "landscape_right", label: "Landscape right" },
] as const;

const IOS_PERMISSIONS: ReadonlyArray<{ value: DevicePermission; label: string }> = [
  { value: "camera", label: "Camera" },
  { value: "microphone", label: "Microphone" },
  { value: "photos", label: "Photos" },
  { value: "contacts", label: "Contacts" },
  { value: "calendar", label: "Calendar" },
  { value: "reminders", label: "Reminders" },
  { value: "location", label: "Location" },
  { value: "notifications", label: "Notifications" },
  { value: "motion", label: "Motion" },
  { value: "media-library", label: "Media library" },
  { value: "faceid", label: "Face ID" },
];

const ANDROID_PERMISSIONS: ReadonlyArray<{ value: DevicePermission; label: string }> = [
  { value: "camera", label: "Camera" },
  { value: "microphone", label: "Microphone" },
  { value: "photos", label: "Photos" },
  { value: "contacts", label: "Contacts" },
  { value: "calendar", label: "Calendar" },
  { value: "location", label: "Location" },
  { value: "notifications", label: "Notifications" },
  { value: "motion", label: "Physical activity" },
];

const LOCATION_PRESETS = [
  { label: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { label: "New York", latitude: 40.7128, longitude: -74.006 },
  { label: "London", latitude: 51.5074, longitude: -0.1278 },
  { label: "Stockholm", latitude: 59.3293, longitude: 18.0686 },
  { label: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
] as const;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** T3's `useDeviceControls`: the device's settings, and its actions one at a time. */
function useDeviceControls(props: {
  readonly device: DeviceSummary;
  readonly threadId: string;
  readonly call: (method: string, params: unknown) => Promise<unknown>;
}) {
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const call = useRef(props.call);
  call.current = props.call;
  const target = { threadId: props.threadId, deviceId: props.device.id };
  useEffect(() => {
    let current = true;
    setDetail(null);
    setError(null);
    setReading(true);
    void call
      .current("device.detail", { threadId: props.threadId, deviceId: props.device.id })
      .then(
        (result) => current && setDetail(result as DeviceDetail),
        (failure: unknown) => current && setError(errorMessage(failure)),
      )
      .finally(() => current && setReading(false));
    return () => {
      current = false;
    };
  }, [props.threadId, props.device.id]);
  // The device the panel shows now: an answer for another one is dropped.
  const shown = useRef("");
  shown.current = `${props.threadId}\u0000${props.device.id}`;
  /** Runs an action; whether it succeeded, for a field to keep what was typed when not. */
  const act = async (action: DeviceAction): Promise<boolean> => {
    const asked = shown.current;
    setPending(true);
    setError(null);
    try {
      // The node answers with the settings read back after the change.
      const next = (await call.current("device.action", { ...target, action })) as DeviceDetail;
      if (shown.current === asked) setDetail(next);
      return true;
    } catch (failure) {
      if (shown.current === asked) setError(errorMessage(failure));
      return false;
    } finally {
      setPending(false);
    }
  };
  return {
    detail,
    pending,
    error,
    foregroundApp: detail?.foregroundApp ?? null,
    // While the first read runs, an action's read-back could be overwritten by it.
    disabled: pending || reading,
    act,
  };
}

/** T3's "Tools" beside an open device's screen. */
export function DeviceToolsPanel(props: {
  readonly device: DeviceSummary;
  readonly threadId: string;
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  readonly onClose: () => void;
  readonly className?: string;
}) {
  const { device } = props;
  const { detail, pending, error, foregroundApp, disabled, act } = useDeviceControls(props);
  const settings = detail?.settings;
  const isIos = device.platform === "ios";

  return (
    <div
      aria-label="Device tools"
      className={cn("flex min-h-0 flex-col border-border bg-background text-sm", props.className)}
      role="region"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="font-medium">Tools</span>
        {pending ? <Spinner className="size-3.5" /> : null}
        <Button
          aria-label="Close tools"
          className="ml-auto"
          onClick={props.onClose}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {detail === null && !error ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> Reading device settings…
          </div>
        ) : null}

        <Section title="App">
          <Row label="Foreground">
            <span className="truncate font-mono text-xs">{foregroundApp?.id ?? "—"}</span>
          </Row>
          {foregroundApp ? (
            <div className="flex gap-1.5">
              <Button
                disabled={disabled}
                onClick={() => void act({ type: "terminateApp", appId: foregroundApp.id })}
                size="xs"
                variant="outline"
              >
                Terminate
              </Button>
              <Button
                disabled={disabled}
                onClick={() => void act({ type: "launchApp", appId: foregroundApp.id })}
                size="xs"
                variant="outline"
              >
                Relaunch
              </Button>
            </div>
          ) : null}
          <SubmitRow
            action="Open"
            disabled={disabled}
            onSubmit={(url) => act({ type: "openUrl", url })}
            placeholder="https://… or myapp://"
          />
          <SubmitRow
            action="Launch"
            disabled={disabled}
            onSubmit={(appId) => act({ type: "launchApp", appId })}
            placeholder={isIos ? "Bundle ID to launch" : "Package name to launch"}
          />
        </Section>

        <Section title={isIos ? "Simulator" : "Emulator"}>
          <Row label="Appearance">
            <ToggleGroup
              aria-label="Appearance"
              // Not read from the device: nothing to switch from (D1333).
              disabled={disabled || settings?.appearance === undefined}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "light" || next === "dark") {
                  void act({ type: "setAppearance", value: next });
                }
              }}
              value={settings?.appearance ? [settings.appearance] : []}
            >
              <ToggleGroupItem value="light">Light</ToggleGroupItem>
              <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
            </ToggleGroup>
          </Row>
          <Row label="Text size">
            <ChoiceSelect
              ariaLabel="Text size"
              disabled={disabled || settings?.textSize === undefined}
              onChange={(value) => act({ type: "setTextSize", value })}
              options={TEXT_SIZES}
              value={settings?.textSize ?? null}
            />
          </Row>
          {isIos ? (
            <>
              <Row label="Liquid Glass">
                <ToggleGroup
                  aria-label="Liquid Glass"
                  disabled={disabled || settings?.liquidGlass === undefined}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "clear" || next === "tinted") {
                      void act({ type: "setLiquidGlass", value: next });
                    }
                  }}
                  value={settings?.liquidGlass ? [settings.liquidGlass] : []}
                >
                  <ToggleGroupItem value="clear">Clear</ToggleGroupItem>
                  <ToggleGroupItem value="tinted">Tinted</ToggleGroupItem>
                </ToggleGroup>
              </Row>
              <Row label="Color filter">
                <ChoiceSelect
                  ariaLabel="Color filter"
                  disabled={disabled || settings?.colorFilter === undefined}
                  onChange={(value) => act({ type: "setColorFilter", value })}
                  options={COLOR_FILTERS}
                  value={settings?.colorFilter ?? null}
                />
              </Row>
            </>
          ) : (
            <Row label="Orientation">
              <ChoiceSelect
                ariaLabel="Orientation"
                disabled={disabled}
                onChange={(value) => act({ type: "setOrientation", value })}
                options={ORIENTATIONS}
                placeholder="Rotate to…"
                value={null}
              />
            </Row>
          )}
          <SwitchRow
            checked={settings?.reduceMotion}
            disabled={disabled}
            label="Reduce Motion"
            onChange={(value) => act({ type: "setToggle", setting: "reduceMotion", value })}
          />
          {isIos ? (
            <>
              <SwitchRow
                checked={settings?.increaseContrast}
                disabled={disabled}
                label="Increase Contrast"
                onChange={(value) => act({ type: "setToggle", setting: "increaseContrast", value })}
              />
              <SwitchRow
                checked={settings?.reduceTransparency}
                disabled={disabled}
                label="Reduce Transparency"
                onChange={(value) =>
                  act({ type: "setToggle", setting: "reduceTransparency", value })
                }
              />
              <SwitchRow
                checked={settings?.showBorders}
                disabled={disabled}
                label="Show Borders"
                onChange={(value) => act({ type: "setToggle", setting: "showBorders", value })}
              />
              <SwitchRow
                checked={settings?.voiceOver}
                disabled={disabled}
                label="VoiceOver"
                onChange={(value) => act({ type: "setToggle", setting: "voiceOver", value })}
              />
            </>
          ) : (
            <SwitchRow
              checked={settings?.networkEnabled}
              disabled={disabled}
              label="Network"
              onChange={(value) => act({ type: "setToggle", setting: "networkEnabled", value })}
            />
          )}
        </Section>

        <LocationSection
          canClear={isIos}
          disabled={disabled}
          onClear={() => act({ type: "clearLocation" })}
          onSet={(latitude, longitude) => act({ type: "setLocation", latitude, longitude })}
        />

        <PermissionsSection
          canReset={isIos}
          defaultAppId={foregroundApp?.id ?? ""}
          disabled={disabled}
          onDecide={(appId, permission, decision) =>
            act({ type: "setPermission", appId, permission, decision })
          }
          permissions={isIos ? IOS_PERMISSIONS : ANDROID_PERMISSIONS}
        />

        {isIos ? (
          <Section title="Push notification">
            <SubmitRow
              action="Send"
              disabled={disabled || !foregroundApp}
              onSubmit={(payload) =>
                foregroundApp
                  ? act({ type: "sendPush", appId: foregroundApp.id, payload })
                  : Promise.resolve(false)
              }
              placeholder="Alert text"
            />
            {!foregroundApp ? (
              <p className="text-xs text-muted-foreground">Open an app first.</p>
            ) : null}
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section
      aria-label={props.title}
      className="flex flex-col gap-2 border-b px-3 py-2.5 last:border-b-0"
    >
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Row(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 items-center justify-end">{props.children}</div>
    </div>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly checked: boolean | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => Promise<unknown>;
}) {
  return (
    <Row label={props.label}>
      <Switch
        aria-label={props.label}
        checked={props.checked ?? false}
        disabled={props.disabled || props.checked === undefined}
        onCheckedChange={(checked) => void props.onChange(checked)}
      />
    </Row>
  );
}

function ChoiceSelect<V extends string>(props: {
  readonly ariaLabel: string;
  readonly value: V | null;
  readonly options: ReadonlyArray<{ readonly value: V; readonly label: string }>;
  readonly disabled: boolean;
  readonly placeholder?: string;
  readonly onChange: (value: V) => Promise<unknown>;
}) {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <Select
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== null && value !== props.value) void props.onChange(value as V);
      }}
      value={props.value}
    >
      <SelectTrigger aria-label={props.ariaLabel} className="w-40" size="xs">
        <SelectValue>
          {current ? (
            current.label
          ) : (
            <span className="text-muted-foreground">{props.placeholder ?? "Unknown"}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function SubmitRow(props: {
  readonly placeholder: string;
  readonly action: string;
  readonly disabled: boolean;
  readonly onSubmit: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    // A failed action keeps the text, to be corrected and sent again.
    void props.onSubmit(trimmed).then((done) => done && setValue(""));
  };
  return (
    <form
      className="flex gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        aria-label={props.placeholder}
        className="min-w-0 flex-1"
        disabled={props.disabled}
        font="mono"
        onChange={(event) => setValue(event.target.value)}
        placeholder={props.placeholder}
        size="compact"
        value={value}
      />
      <Button
        disabled={props.disabled || value.trim().length === 0}
        size="xs"
        type="submit"
        variant="outline"
      >
        {props.action}
      </Button>
    </form>
  );
}

function LocationSection(props: {
  readonly disabled: boolean;
  readonly canClear: boolean;
  readonly onSet: (latitude: number, longitude: number) => Promise<unknown>;
  readonly onClear: () => Promise<unknown>;
}) {
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  const valid =
    latitude.trim() !== "" &&
    longitude.trim() !== "" &&
    Math.abs(parsed.latitude) <= 90 &&
    Math.abs(parsed.longitude) <= 180;
  return (
    <Section title="Location">
      <div className="flex gap-1.5">
        <Input
          aria-label="Latitude"
          className="min-w-0 flex-1"
          disabled={props.disabled}
          font="mono"
          inputMode="decimal"
          onChange={(event) => setLatitude(event.target.value)}
          placeholder="Latitude"
          size="compact"
          value={latitude}
        />
        <Input
          aria-label="Longitude"
          className="min-w-0 flex-1"
          disabled={props.disabled}
          font="mono"
          inputMode="decimal"
          onChange={(event) => setLongitude(event.target.value)}
          placeholder="Longitude"
          size="compact"
          value={longitude}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select<string | null>
          disabled={props.disabled}
          onValueChange={(value) => {
            const preset = LOCATION_PRESETS.find((candidate) => candidate.label === value);
            if (!preset) return;
            setLatitude(String(preset.latitude));
            setLongitude(String(preset.longitude));
            void props.onSet(preset.latitude, preset.longitude);
          }}
          value={null}
        >
          <SelectTrigger aria-label="Location preset" className="w-32" size="xs">
            <SelectValue>
              <span className="text-muted-foreground">Preset…</span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {LOCATION_PRESETS.map((preset) => (
              <SelectItem key={preset.label} value={preset.label}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          disabled={props.disabled || !valid}
          onClick={() => void props.onSet(parsed.latitude, parsed.longitude)}
          size="xs"
          variant="outline"
        >
          Set
        </Button>
        {props.canClear ? (
          <Button
            disabled={props.disabled}
            onClick={() => {
              setLatitude("");
              setLongitude("");
              void props.onClear();
            }}
            size="xs"
            variant="ghost"
          >
            Clear
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function PermissionsSection(props: {
  readonly permissions: ReadonlyArray<{ value: DevicePermission; label: string }>;
  readonly canReset: boolean;
  readonly defaultAppId: string;
  readonly disabled: boolean;
  readonly onDecide: (
    appId: string,
    permission: DevicePermission,
    decision: "grant" | "revoke" | "reset",
  ) => Promise<unknown>;
}) {
  const [appId, setAppId] = useState("");
  const [permission, setPermission] = useState<DevicePermission>("camera");
  const resolvedAppId = appId.trim() || props.defaultAppId;
  const decide = (decision: "grant" | "revoke" | "reset") =>
    void props.onDecide(resolvedAppId, permission, decision);
  return (
    <Section title="Permissions">
      <Input
        aria-label="App ID"
        disabled={props.disabled}
        font="mono"
        onChange={(event) => setAppId(event.target.value)}
        placeholder={props.defaultAppId || "App ID"}
        size="compact"
        value={appId}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <ChoiceSelect
          ariaLabel="Permission"
          disabled={props.disabled}
          onChange={(value) => {
            setPermission(value);
            return Promise.resolve();
          }}
          options={props.permissions}
          value={permission}
        />
        <Button
          disabled={props.disabled || !resolvedAppId}
          onClick={() => decide("grant")}
          size="xs"
          variant="outline"
        >
          Grant
        </Button>
        <Button
          disabled={props.disabled || !resolvedAppId}
          onClick={() => decide("revoke")}
          size="xs"
          variant="outline"
        >
          Revoke
        </Button>
        {props.canReset ? (
          <Button
            disabled={props.disabled || !resolvedAppId}
            onClick={() => decide("reset")}
            size="xs"
            variant="ghost"
          >
            Reset
          </Button>
        ) : null}
      </div>
    </Section>
  );
}
