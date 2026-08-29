/**
 * `/` — the platform's front door, and the one screen that renders without a
 * session. A hero band that names the site and greets you, then the services
 * this origin hosts: the public ones, then the ones that want a sign-in.
 */
import { Button } from "@herkules/ui/components/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@herkules/ui/components/card";
import { Link } from "@tanstack/react-router";

import { SectionTitle } from "../layout.tsx";
import { useSession } from "../session.tsx";
import type { Service } from "../services.ts";
import { SERVICES, serviceHref } from "../services.ts";

export function HomePage() {
  const { session } = useSession();
  return (
    <>
      <Hero name={session === undefined ? undefined : (session?.user.name ?? null)} />
      <SectionTitle className="mt-10">Services</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        {SERVICES.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            locked={service.access === "member" && session === null}
          />
        ))}
      </div>
    </>
  );
}

/**
 * The photograph is dark in every theme, so the type over it is white in every
 * theme too — the one place in the app that does not read from the tokens.
 * `name`: a string when signed in, null when signed out, undefined while the
 * session query is still in flight.
 */
function Hero({ name }: { name?: string | null }) {
  return (
    <section className="relative overflow-hidden rounded-lg border border-line">
      <img
        src="/hero.webp"
        alt=""
        width={1920}
        height={640}
        className="h-48 w-full object-cover sm:h-56"
      />
      <div className="absolute inset-0 bg-linear-to-r from-black/85 via-black/65 to-black/30" />
      <div className="absolute inset-0 flex flex-col justify-center px-7 sm:px-9">
        <p className="font-display text-3xl tracking-[0.01em] text-white sm:text-4xl">herkules</p>
        <div className="mt-1 min-h-9 text-white/85">
          {name === undefined ? null : name === null ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span>The team&rsquo;s identity layer and internal services.</span>
              <Button size="sm" variant="secondary" asChild>
                <Link to="/login" search={{ next: "/" }} className="hover:no-underline">
                  Sign in
                </Link>
              </Button>
            </div>
          ) : (
            <span>Hello, {name}.</span>
          )}
        </div>
        {/* Reminders and whatever else this band grows into belong here. */}
      </div>
    </section>
  );
}

function ServiceCard({ service, locked }: { service: Service; locked: boolean }) {
  const href = serviceHref(service);
  const host = new URL(href).host;

  if (!locked)
    return (
      <a href={href} className="group block hover:no-underline">
        <Card className="h-full gap-3 transition-colors group-hover:border-accent">
          <Body title={service.title} blurb={service.blurb} host={host} />
        </Card>
      </a>
    );

  /*
   * Blurred, not hidden: the card says the service exists and that a session
   * opens it. It is a signpost, NOT a boundary — the real gate is the target's
   * own sign-in, and anyone may type the hostname. The blurred copy is
   * aria-hidden so a screen reader is not read decoration; the overlay carries
   * the only link.
   */
  return (
    <Card className="relative h-full gap-3 overflow-hidden">
      <div aria-hidden className="pointer-events-none blur-[3px] select-none">
        <Body title={service.title} blurb={service.blurb} host={host} />
      </div>
      <div className="absolute inset-0 grid place-items-center bg-surface/55">
        <Button variant="outline" size="sm" asChild>
          <Link to="/login" search={{ next: "/" }} className="hover:no-underline">
            <LockIcon />
            Sign in to open {service.title}
          </Link>
        </Button>
      </div>
    </Card>
  );
}

function Body({ title, blurb, host }: { title: string; blurb: string; host: string }) {
  return (
    <>
      <CardHeader>
        <CardTitle className="font-display text-lg font-medium">{title}</CardTitle>
        <CardDescription>{blurb}</CardDescription>
      </CardHeader>
      <CardFooter>
        <span className="font-mono text-xs text-muted-foreground">{host}</span>
      </CardFooter>
    </>
  );
}

/** Inline rather than lucide: `services/web` does not depend on an icon package for one glyph. */
function LockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
      aria-hidden
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
