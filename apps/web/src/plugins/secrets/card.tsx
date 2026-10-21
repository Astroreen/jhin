// T3 Code's SecretRequestCard (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/SecretRequestCard.tsx and
// packages/client-runtime/src/secretRequest.ts.
import {
  CONNECTIONS_CAPABILITY,
  THREADS_CAPABILITY,
  type ChatTurnItemProps,
  type Connections,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  SECRET_REQUEST_PRIVACY_NOTE,
  SecretsThreadEvents,
  secretRequestClosedLabel,
  type SecretRequestOpened,
  type SecretRequestStatus,
} from "@jhin/secrets-api";
import { Button, Input } from "@jhin/ui";
import { CheckIcon, MinusIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from "react";

import { secretRequestFailureMessage } from "./failure.ts";

interface SecretRequestServices {
  readonly connections: Connections;
  readonly threads: ThreadsCatalog;
}

function readOpened(payload: unknown): SecretRequestOpened | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const opened = payload as Partial<SecretRequestOpened>;
  return typeof opened.requestId === "string" &&
    typeof opened.label === "string" &&
    typeof opened.reason === "string"
    ? (opened as SecretRequestOpened)
    : undefined;
}

/** The request's close, followed on the thread's stream after the card's own event. */
function useClosed(props: ChatTurnItemProps, services: SecretRequestServices, requestId: string) {
  const [status, setStatus] = useState<SecretRequestStatus | undefined>(undefined);
  const { target, thread, event } = props;
  useEffect(() => {
    let stopped = false;
    let subscription: { dispose(): void } | undefined;
    void services.threads
      .open(target, thread.id)
      .then((stream) => {
        const client = services.connections.get(target.node)?.client;
        if (stopped || client === undefined) return;
        subscription = client.subscribe(stream, { after: event.sequence }, (next) => {
          const closed = next.payload as { requestId?: unknown; status?: unknown } | null;
          if (next.type === SecretsThreadEvents.requestClosed && closed?.requestId === requestId) {
            setStatus(closed.status as SecretRequestStatus);
          }
        });
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      subscription?.dispose();
    };
  }, [services, target.node, target.remote, thread.id, event.sequence, requestId]);
  return status;
}

/** The `chat.turn.item` contribution: a card for each `secrets.request.opened`. */
export function secretRequestItem(context: PluginContext) {
  const services: SecretRequestServices = {
    connections: context.services.get<Connections>(CONNECTIONS_CAPABILITY),
    threads: context.services.get<ThreadsCatalog>(THREADS_CAPABILITY),
  };
  return function SecretRequestItem(props: ChatTurnItemProps) {
    if (props.event.type !== SecretsThreadEvents.requestOpened) return null;
    const request = readOpened(props.event.payload);
    return request === undefined ? null : <Card {...props} request={request} services={services} />;
  };
}

function Card(
  props: ChatTurnItemProps & { services: SecretRequestServices; request: SecretRequestOpened },
) {
  const { request, services } = props;
  const status = useClosed(props, services, request.requestId);
  if (status !== undefined) {
    const Icon = status === "saved" ? CheckIcon : MinusIcon;
    return (
      <div
        className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground"
        data-item-type="secret-request"
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {request.label} · {secretRequestClosedLabel(status)}
        </span>
      </div>
    );
  }
  return <PendingForm {...props} />;
}

function PendingForm(
  props: ChatTurnItemProps & { services: SecretRequestServices; request: SecretRequestOpened },
) {
  const { request, services, target, thread } = props;
  const inputId = useId();
  const errorId = useId();
  const privacyId = useId();
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (answer: { type: "save"; secret: string } | { type: "decline" }) => {
    if (inFlight.current) return;
    if (answer.type === "save" && answer.secret.trim() === "") return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await services.threads.call(target, "secrets.requests.answer", {
        threadId: thread.id,
        requestId: request.requestId,
        answer: answer.type === "save" ? { type: "save", secret: answer.secret.trim() } : answer,
      });
      setSecret("");
    } catch (failure) {
      setError(secretRequestFailureMessage(failure));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send({ type: "save", secret });
  };

  return (
    <form
      aria-label={request.label}
      autoComplete="off"
      className="mx-1 mb-4 flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      data-item-type="secret-request"
      onPointerDown={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        if (event.target.closest("input, button, a")) return;
        document.getElementById(inputId)?.focus();
      }}
      onSubmit={onSubmit}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-sm font-medium text-foreground" htmlFor={inputId}>
          {request.label}
        </label>
        {request.reason.trim() ? (
          <p className="text-sm text-muted-foreground">{request.reason}</p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            aria-describedby={error !== null ? `${privacyId} ${errorId}` : privacyId}
            aria-invalid={error !== null || undefined}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            // Password managers otherwise offer to save or fill this field.
            data-1p-ignore
            data-bwignore
            data-lpignore="true"
            disabled={submitting}
            id={inputId}
            onChange={(event) => setSecret(event.currentTarget.value)}
            placeholder={request.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
            spellCheck={false}
            // Masked text rather than a password field: browsers offer to
            // save any submitted password, and this is not a login. On the
            // field itself: the component's class goes to its frame.
            style={{ WebkitTextSecurity: "disc" } as CSSProperties}
            type="text"
            value={secret}
          />
        </div>
        <Button disabled={submitting || secret.trim().length === 0} type="submit">
          Save securely
        </Button>
      </div>
      {error !== null ? (
        <p className="text-xs text-destructive" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          id={privacyId}
        >
          <ShieldCheckIcon aria-hidden className="size-3.5 shrink-0" />
          {SECRET_REQUEST_PRIVACY_NOTE}
        </p>
        <Button
          disabled={submitting}
          onClick={() => void send({ type: "decline" })}
          size="xs"
          type="button"
          variant="ghost-muted"
        >
          Decline
        </Button>
      </div>
    </form>
  );
}
