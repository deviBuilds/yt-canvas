import { CircleCheck, CircleX, Gauge, LoaderCircle, MapPin, Play, Send, Square, Wifi } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { StreamSession } from "@/api/types";
import { prepareBenchmark, runBenchmark, type BenchmarkResult } from "@/check/benchmark";
import { measureSpeed, type SpeedResult } from "@/check/network";
import { collectCapabilities, type Capabilities, type CodecResult } from "@/check/probes";
import { sendReport, type CheckReport } from "@/check/report";
import { checkLocation, DriveLockProbe, type DriveLockResult, type LocationResult } from "@/check/vehicle";
import { Button } from "@/components/ui/button";

type Status = "idle" | "running" | "done" | "error";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mt-6 rounded-xl bg-secondary p-4" aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function YesNo({ value, error }: { value: boolean | null | undefined; error?: string }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">{error ?? "unknown"}</span>;
  return value ? (
    <span className="inline-flex items-center gap-1">
      <CircleCheck className="size-4 text-[#2ba640]" aria-hidden="true" /> yes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <CircleX className="size-4" aria-hidden="true" /> no{error ? ` (${error})` : ""}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function CodecTable({ rows, hardware }: { rows: CodecResult[]; hardware: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1.5 pr-3 font-normal">Codec</th>
            <th className="py-1.5 pr-3 font-normal">Decodes</th>
            {hardware && <th className="py-1.5 font-normal">In hardware</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-t border-border/60">
              <td className="py-1.5 pr-3">
                {row.label} <span className="text-xs text-muted-foreground">{row.codec}</span>
              </td>
              <td className="py-1.5 pr-3">
                <YesNo value={row.supported} error={row.error} />
              </td>
              {hardware && <td className="py-1.5">{row.supported ? <YesNo value={row.hardware} /> : "–"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Running({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> {children}
    </p>
  );
}

/**
 * Measures what this browser can do for yt-canvas, so the player can be tuned for it:
 * meant to be opened in other browsers too, such as a Tesla's, through a tunnel.
 * Nothing personal is collected or sent.
 */
export function CheckView() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fail = useCallback((step: string, err: unknown) => setErrors((all) => ({ ...all, [step]: message(err) })), []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [session, setSession] = useState<StreamSession | null>(null);
  const [benchStatus, setBenchStatus] = useState<Status>("idle");
  const [bench, setBench] = useState<BenchmarkResult | null>(null);

  const [speedStatus, setSpeedStatus] = useState<Status>("idle");
  const [speed, setSpeed] = useState<SpeedResult | null>(null);

  const [locationStatus, setLocationStatus] = useState<Status>("idle");
  const [location, setLocation] = useState<LocationResult | null>(null);

  const probeVideoRef = useRef<HTMLVideoElement>(null);
  const probeRef = useRef<DriveLockProbe | null>(null);
  const [, setProbeTick] = useState(0);
  const [driveLock, setDriveLock] = useState<DriveLockResult | null>(null);

  const [sendStatus, setSendStatus] = useState<Status>("idle");
  const [sentId, setSentId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    collectCapabilities().then(
      (result) => live && setCaps(result),
      (err) => live && fail("capabilities", err),
    );
    return () => {
      live = false;
    };
  }, [fail]);

  const prepare = useCallback(() => {
    setSession(null);
    prepareBenchmark().then(setSession, (err) => {
      fail("benchmark", err);
      setBenchStatus("error");
    });
  }, [fail]);
  useEffect(prepare, [prepare]);
  useEffect(() => () => void probeRef.current?.stop(), []);

  // Must stay synchronous up to runBenchmark(): its first play() needs this tap.
  const runBench = () => {
    const canvas = canvasRef.current;
    if (!session || !canvas) return;
    if (session.expires_at * 1000 < Date.now() + 30_000) {
      prepare();
      return;
    }
    setBench(null);
    setBenchStatus("running");
    runBenchmark(canvas, session).then(
      (result) => {
        setBench(result);
        setBenchStatus("done");
      },
      (err) => {
        fail("benchmark", err);
        setBenchStatus("error");
      },
    );
  };

  const runSpeed = () => {
    setSpeed(null);
    setSpeedStatus("running");
    measureSpeed().then(
      (result) => {
        setSpeed(result);
        setSpeedStatus("done");
      },
      (err) => {
        fail("speed", err);
        setSpeedStatus("error");
      },
    );
  };

  const runLocation = () => {
    setLocationStatus("running");
    void checkLocation().then((result) => {
      setLocation(result);
      setLocationStatus("done");
    });
  };

  const startProbe = () => {
    const video = probeVideoRef.current;
    if (!video) return;
    setDriveLock(null);
    const probe = new DriveLockProbe(video, () => setProbeTick((n) => n + 1));
    probeRef.current = probe;
    probe.start().catch((err: unknown) => fail("driveLock", err));
    setProbeTick((n) => n + 1);
  };

  const stopProbe = () => {
    const probe = probeRef.current;
    if (!probe) return;
    probeRef.current = null;
    setDriveLock(probe.stop());
  };

  const report: CheckReport | null = caps && {
    version: 1,
    takenAt: new Date().toISOString(),
    ...caps,
    benchmark: bench,
    speed,
    location,
    driveLock,
    errors,
  };

  const send = () => {
    if (!report) return;
    setSendStatus("running");
    sendReport(report).then(
      (sent) => {
        setSentId(sent.id);
        setSendStatus("done");
      },
      (err) => {
        fail("send", err);
        setSendStatus("error");
      },
    );
  };

  const probe = probeRef.current;
  const probeEvents = probe ? probe.events : (driveLock?.events ?? []);

  return (
    <div className="mx-auto max-w-[860px] px-4 py-8 sm:px-6">
      <h1 className="text-3xl font-bold">Browser check</h1>
      <p className="mt-2 text-muted-foreground">
        Measures what this browser can do for yt-canvas: which video and audio it can decode, how smoothly it plays
        1080p60, and how fast it reaches this server. Open it in any browser, such as your car's, then send the report.
        No location, account or personal data is sent.
      </p>

      <Section title="This browser">
        {caps ? (
          <>
            <Stat label="Chromium" value={caps.browser.chromium ?? "not Chromium"} />
            <Stat label="Tesla software" value={caps.browser.tesla ?? "not a Tesla"} />
            <Stat label="WebCodecs" value={<YesNo value={caps.apis.webCodecs} />} />
            <Stat label="Screen" value={`${caps.device.screen.join(" × ")} at ${caps.device.pixelRatio}x`} />
            <Stat label="Page area" value={caps.device.viewport.join(" × ")} />
            <Stat label="CPU cores" value={caps.device.cores ?? "unknown"} />
            <Stat label="User agent" value={<span className="break-all text-xs font-normal">{caps.userAgent}</span>} />
          </>
        ) : errors.capabilities ? (
          <p className="text-sm text-danger">{errors.capabilities}</p>
        ) : (
          <Running>Checking…</Running>
        )}
      </Section>

      {caps && (
        <>
          <Section title="Video decoding (1080p)">
            <CodecTable rows={caps.video} hardware />
          </Section>
          <Section title="Audio decoding">
            <CodecTable rows={caps.audio} hardware={false} />
          </Section>
          <Section title="Other features">
            <div className="grid gap-x-6 sm:grid-cols-2">
              {Object.entries(caps.apis).map(([name, value]) => (
                <Stat key={name} label={name} value={<YesNo value={value} />} />
              ))}
              {caps.mse.map(({ type, supported }) => (
                <Stat key={type} label={`MSE ${type}`} value={<YesNo value={supported} />} />
              ))}
              <Stat label="Widevine DRM" value={<YesNo value={caps.drm.widevine} />} />
            </div>
          </Section>
        </>
      )}

      <Section
        title="Playback benchmark"
        action={
          <Button variant="primary" onClick={runBench} disabled={!session || benchStatus === "running"}>
            <Gauge /> {benchStatus === "done" ? "Run again" : "Run (about 15 s)"}
          </Button>
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">
          Plays a 1080p60 H.264 clip through the canvas player, muted, after loading all of it, and counts the frames it
          shows.
        </p>
        <canvas ref={canvasRef} className="aspect-video w-full rounded-lg bg-black" aria-label="Benchmark video" />
        <div className="mt-3" aria-live="polite">
          {!session && benchStatus !== "error" && <Running>Preparing the clip…</Running>}
          {benchStatus === "running" && <Running>Running…</Running>}
          {benchStatus === "error" && <p className="text-sm text-danger">{errors.benchmark}</p>}
          {bench && (
            <>
              <Stat label="Frames per second" value={`${bench.fps} of ${bench.targetFps}`} />
              <Stat label="Dropped frames" value={bench.dropped} />
              <Stat label="Stalls waiting for data" value={bench.waiting} />
              <Stat label="Playback speed" value={`${bench.speed}x real time`} />
              <Stat label="Page frame rate" value={`${bench.animationFps} fps, longest gap ${bench.longestGapMs} ms`} />
              <Stat label="First frame" value={`${bench.firstFrameMs} ms`} />
              <Stat label="Whole clip loaded" value={bench.bufferedMs === null ? "not in time" : `${bench.bufferedMs} ms`} />
              <Stat
                label="Audio output"
                value={
                  bench.audio
                    ? `${bench.audio.sampleRate} Hz, latency ${Math.round(((bench.audio.outputLatency ?? 0) + (bench.audio.baseLatency ?? 0)) * 1000)} ms`
                    : "none"
                }
              />
            </>
          )}
        </div>
      </Section>

      <Section
        title="Connection to this server"
        action={
          <Button onClick={runSpeed} disabled={speedStatus === "running"}>
            <Wifi /> {speedStatus === "done" ? "Test again" : "Test speed"}
          </Button>
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">
          Downloads up to 24 MB from this server, the same way video reaches the player. Helps pick a bitrate.
        </p>
        <div aria-live="polite">
          {speedStatus === "running" && <Running>Downloading…</Running>}
          {speedStatus === "error" && <p className="text-sm text-danger">{errors.speed}</p>}
          {speed && (
            <>
              <Stat label="Speed" value={`${speed.mbps} Mbit/s`} />
              <Stat label="Latency" value={`${speed.latencyMs} ms`} />
              <Stat label="Downloaded" value={`${(speed.bytes / 1048576).toFixed(1)} MB in ${speed.seconds} s`} />
            </>
          )}
        </div>
      </Section>

      <Section
        title="Location speed (optional)"
        action={
          <Button onClick={runLocation} disabled={locationStatus === "running"}>
            <MapPin /> Check
          </Button>
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">
          Could the player tell that the car is moving, so it can pause the picture? This asks for your location once
          and reports only whether it includes a speed. Where you are is never sent.
        </p>
        <div aria-live="polite">
          {locationStatus === "running" && <Running>Asking for location…</Running>}
          {location && (
            <>
              <Stat label="Location available" value={<YesNo value={location.available} />} />
              <Stat label="Allowed" value={<YesNo value={location.granted} error={location.error ?? undefined} />} />
              <Stat label="Includes speed" value={<YesNo value={location.speedAvailable} />} />
              {location.speedMps !== null && <Stat label="Speed now" value={`${location.speedMps} m/s`} />}
            </>
          )}
        </div>
      </Section>

      <Section
        title="Drive lock probe (optional, in the car)"
        action={
          probe ? (
            <Button onClick={stopProbe}>
              <Square /> Stop
            </Button>
          ) : (
            <Button onClick={startProbe}>
              <Play /> Start
            </Button>
          )
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">
          Plays a tiny muted video and records whether the browser stops it. While parked: tap Start, shift into Drive
          with the brake held for about 5 seconds, shift back to Park, then tap Stop.
        </p>
        <video ref={probeVideoRef} className="mb-3 w-40 rounded bg-black" aria-label="Drive lock probe video" />
        {driveLock && (
          <>
            <Stat label="Paused by the browser" value={driveLock.browserPauses} />
            <Stat label="Froze while playing" value={driveLock.freezes} />
          </>
        )}
        {errors.driveLock && <p className="text-sm text-danger">{errors.driveLock}</p>}
        {probeEvents.length > 0 && (
          <ol className="mt-2 max-h-48 overflow-y-auto text-xs text-muted-foreground">
            {probeEvents.map((event, i) => (
              <li key={i}>
                {event.t.toFixed(1)} s: {event.event}
                {event.paused ? " (paused)" : ""}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section
        title="Send the report"
        action={
          <Button variant="primary" onClick={send} disabled={!report || sendStatus === "running"}>
            <Send /> Send
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">
          Sends what this page measured to the computer running yt-canvas. Run the benchmark and speed test first for
          the most useful report.
        </p>
        <div className="mt-2" aria-live="polite">
          {sendStatus === "running" && <Running>Sending…</Running>}
          {sendStatus === "done" && sentId && (
            <p className="flex items-center gap-2 text-sm">
              <CircleCheck className="size-4 text-[#2ba640]" aria-hidden="true" /> Sent. Report <strong>{sentId}</strong>
            </p>
          )}
          {sendStatus === "error" && <p className="text-sm text-danger">{errors.send}</p>}
        </div>
        {report && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Show the report</summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded bg-background p-2">{JSON.stringify(report, null, 2)}</pre>
          </details>
        )}
      </Section>
    </div>
  );
}
