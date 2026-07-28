import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  CircleGauge,
  Download,
  FileText,
  Lightbulb,
  Mail,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BusinessHubError,
  getReport,
  getReportHistory,
  getReportPreferences,
} from "@/lib/business-insights/client";
import type {
  DataQuality,
  InsightMetric,
  ReportHistoryItem,
  ReportPreferences,
} from "@/lib/business-insights/types";
import { buildReportView } from "@/lib/business-insights/view-model";
import {
  ForbiddenError,
  UnauthorizedError,
  getCurrentAccount,
} from "@/lib/auth/account";
import { saveReportPreferences } from "./actions";

export const metadata: Metadata = { title: "Business Copilot" };

interface Props {
  params: Promise<{ workspaceId: string; reportId: string }>;
  searchParams: Promise<{ preferences?: string }>;
}

export default async function BusinessReportPage({ params, searchParams }: Props) {
  const { workspaceId, reportId } = await params;
  const query = await searchParams;
  const canonicalPath = `/business-insights/workspaces/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}`;
  const t = await getTranslations("BusinessInsights");

  let account;
  try {
    account = await getCurrentAccount();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect(`/login?next=${encodeURIComponent(canonicalPath)}`);
    }
    if (error instanceof ForbiddenError) forbidden();
    throw error;
  }

  const actor = { userId: account.userId, accountId: account.accountId };
  let envelope;
  try {
    envelope = await getReport(actor, workspaceId, reportId);
  } catch (error) {
    if (error instanceof BusinessHubError && error.status === 403) forbidden();
    if (error instanceof BusinessHubError && error.status === 404) notFound();
    throw error;
  }

  const view = buildReportView(envelope);
  if (!view.canViewBasic) {
    return (
      <PlanRestricted
        plan={view.plan}
        title={t("restrictedTitle")}
        description={t("restrictedDescription")}
      />
    );
  }

  const [historyResult, preferencesResult] = await Promise.allSettled([
    view.capabilities.report_history
      ? getReportHistory(actor, workspaceId)
      : Promise.resolve({ reports: [] }),
    view.canConfigure
      ? getReportPreferences(actor, workspaceId)
      : Promise.resolve(null),
  ]);
  const history =
    historyResult.status === "fulfilled" ? historyResult.value.reports : [];
  const preferences =
    preferencesResult.status === "fulfilled" ? preferencesResult.value : null;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 pb-10">
      <header className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="uppercase tracking-wide">
              {t("plan", { plan: view.plan })}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {formatPeriod(view.report.period_start, view.report.period_end)}
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {view.report.business_name}
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            {t("generatedAt", { date: formatDateTime(view.report.generated_at) })}
          </p>
        </div>
        {view.canDownload ? (
          <Button
            size="lg"
            render={
              <a
                href={`/api/business-insights/workspaces/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/download`}
              />
            }
          >
            <Download data-icon="inline-start" />
            {t("download")}
          </Button>
        ) : null}
      </header>

      {query.preferences === "saved" ? (
        <Notice tone="success">{t("preferencesSaved")}</Notice>
      ) : null}
      {query.preferences === "invalid" ? (
        <Notice tone="warning">{t("preferencesInvalid")}</Notice>
      ) : null}

      {!view.hasData ? (
        <NoData />
      ) : (
        <>
          <DecisionHero report={view.report} />
          <Analytics metrics={view.metrics} full={view.canViewFull} />
          {view.canViewFull ? <DataQualityPanel report={view.report} /> : null}
        </>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <ReportHistory
          reports={history}
          workspaceId={workspaceId}
          currentReportId={reportId}
        />
        {view.canConfigure && preferences ? (
          <Preferences
            preferences={preferences}
            workspaceId={workspaceId}
            reportId={reportId}
            allowEmail={view.canConfigureEmail}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{t("deliveryTitle")}</CardTitle>
              <CardDescription>{t("plusDelivery")}</CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </div>
  );
}

async function DecisionHero({ report }: { report: ReturnType<typeof buildReportView>["report"] }) {
  const t = await getTranslations("BusinessInsights");
  return (
    <section aria-labelledby="decision-title" className="grid gap-4 lg:grid-cols-12">
      <Card className="relative lg:col-span-7">
        <div className="absolute inset-y-0 left-0 w-1 bg-primary" />
        <CardHeader className="pl-6">
          <div className="mb-2 flex items-center gap-2 text-primary">
            <CircleGauge className="size-5" aria-hidden="true" />
            <span className="text-xs font-semibold uppercase tracking-[0.16em]">
              {t("businessState")}
            </span>
          </div>
          <CardTitle id="decision-title" className="text-2xl">
            {report.business_state}
          </CardTitle>
          <CardDescription className="max-w-2xl text-base leading-7 text-foreground/80">
            {report.executive_summary}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 pl-6 sm:grid-cols-3">
          <DecisionList icon={ArrowUpRight} title={t("changes")} items={report.changes} />
          <DecisionList icon={AlertTriangle} title={t("risks")} items={report.risks} />
          <DecisionList icon={Lightbulb} title={t("opportunities")} items={report.opportunities} />
        </CardContent>
      </Card>

      <Card className="bg-primary text-primary-foreground lg:col-span-5">
        <CardHeader>
          <div className="flex items-center gap-2 text-primary-foreground/75">
            <Target className="size-5" aria-hidden="true" />
            <span className="text-xs font-semibold uppercase tracking-[0.16em]">
              {t("actionsToday")}
            </span>
          </div>
          <CardTitle className="text-xl">{t("priorityActions")}</CardTitle>
        </CardHeader>
        <CardContent>
          {report.priority_actions.length ? (
            <ol className="space-y-4">
              {report.priority_actions.slice(0, 3).map((action, index) => (
                <li key={`${action.title}-${index}`} className="flex gap-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-foreground text-xs font-bold text-primary">
                    {index + 1}
                  </span>
                  <div>
                    <p className="font-semibold">{action.title}</p>
                    <p className="mt-1 text-sm leading-5 text-primary-foreground/75">
                      {action.reason}
                    </p>
                    {action.expected_impact ? (
                      <p className="mt-1 text-xs font-medium text-primary-foreground/90">
                        {action.expected_impact}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-primary-foreground/75">{t("noActions")}</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function DecisionList({
  icon: Icon,
  title,
  items,
}: {
  icon: typeof ArrowUpRight;
  title: string;
  items: string[];
}) {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-primary" aria-hidden="true" />
        {title}
      </h2>
      <ul className="mt-2 space-y-2 text-sm leading-5 text-muted-foreground">
        {items.slice(0, 2).map((item) => <li key={item}>{item}</li>)}
        {!items.length ? <li>Sem alterações relevantes.</li> : null}
      </ul>
    </div>
  );
}

async function Analytics({ metrics, full }: { metrics: InsightMetric[]; full: boolean }) {
  const t = await getTranslations("BusinessInsights");
  return (
    <section aria-labelledby="analytics-title" className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 id="analytics-title" className="text-lg font-semibold">
            {full ? t("fullAnalytics") : t("basicAnalytics")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("analyticsDescription")}</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => <MetricCard key={metric.key} metric={metric} />)}
      </div>
    </section>
  );
}

async function MetricCard({ metric }: { metric: InsightMetric }) {
  const t = await getTranslations("BusinessInsights");
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardDescription>{metric.label}</CardDescription>
          <QualityBadge quality={metric.quality} />
        </div>
        <CardTitle className="text-2xl tabular-nums">{metric.value}</CardTitle>
        {metric.change ? (
          <p className="flex items-center gap-1 text-xs font-medium text-foreground">
            {metric.change.startsWith("-") ? (
              <ArrowDownRight className="size-3.5" aria-hidden="true" />
            ) : (
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            )}
            {metric.change}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer rounded-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t("methodology")}
          </summary>
          <dl className="mt-2 space-y-1 leading-5">
            <div><dt className="inline font-medium">{t("source")}:</dt> <dd className="inline">{metric.source}</dd></div>
            <div><dt className="inline font-medium">{t("period")}:</dt> <dd className="inline">{metric.period}</dd></div>
            {metric.coverage ? <div><dt className="inline font-medium">{t("coverage")}:</dt> <dd className="inline">{metric.coverage}</dd></div> : null}
            {metric.methodology ? <div><dt className="sr-only">{t("methodology")}</dt><dd>{metric.methodology}</dd></div> : null}
          </dl>
        </details>
      </CardContent>
    </Card>
  );
}

async function QualityBadge({ quality }: { quality: DataQuality }) {
  const t = await getTranslations("BusinessInsights");
  const style = {
    confirmed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    inferred: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    estimated: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  }[quality];
  return <Badge variant="outline" className={style}>{t(`quality.${quality}`)}</Badge>;
}

async function DataQualityPanel({ report }: { report: ReturnType<typeof buildReportView>["report"] }) {
  const t = await getTranslations("BusinessInsights");
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
          <CardTitle>{t("dataQuality")}</CardTitle>
        </div>
        <CardDescription>{t("dataQualityDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        <div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("coverage")}</p><p className="mt-1 text-xl font-semibold tabular-nums">{report.data_quality.coverage}</p></div>
        <div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("missingSources")}</p><p className="mt-1 text-sm leading-6">{report.data_quality.missing_sources.join(", ") || t("none")}</p></div>
        <div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("notes")}</p><p className="mt-1 text-sm leading-6">{report.data_quality.notes.join(" ") || t("none")}</p></div>
      </CardContent>
    </Card>
  );
}

async function ReportHistory({ reports, workspaceId, currentReportId }: { reports: ReportHistoryItem[]; workspaceId: string; currentReportId: string }) {
  const t = await getTranslations("BusinessInsights");
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2"><FileText className="size-5 text-primary" aria-hidden="true" /><CardTitle>{t("history")}</CardTitle></div>
        <CardDescription>{t("historyDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {reports.length ? (
          <ul className="divide-y divide-border">
            {reports.map((item) => (
              <li key={item.id}>
                <Link href={`/business-insights/workspaces/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(item.id)}`} className="flex min-h-14 items-center justify-between gap-4 rounded-md px-2 py-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <div><p className="font-medium">{formatPeriod(item.period_start, item.period_end)}</p><p className="text-xs text-muted-foreground">{formatDateTime(item.generated_at)}</p></div>
                  <div className="flex items-center gap-2">{item.id === currentReportId ? <Badge variant="secondary">{t("current")}</Badge> : null}<ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" /></div>
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="py-4 text-sm text-muted-foreground">{t("emptyHistory")}</p>}
      </CardContent>
    </Card>
  );
}

async function Preferences({ preferences, workspaceId, reportId, allowEmail }: { preferences: ReportPreferences; workspaceId: string; reportId: string; allowEmail: boolean }) {
  const t = await getTranslations("BusinessInsights");
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2"><CalendarDays className="size-5 text-primary" aria-hidden="true" /><CardTitle>{t("preferences")}</CardTitle></div>
        <CardDescription>{t("preferencesDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={saveReportPreferences} className="space-y-4">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <input type="hidden" name="report_id" value={reportId} />
          <div className="space-y-2">
            <Label htmlFor="interval_days">{t("interval")}</Label>
            <Input id="interval_days" name="interval_days" type="number" min={15} max={30} step={1} defaultValue={preferences.interval_days} required className="h-11" />
            <p className="text-xs text-muted-foreground">{t("intervalHelp")}</p>
          </div>
          {allowEmail ? (
            <div className="space-y-2">
              <Label htmlFor="report_email" className="flex items-center gap-2"><Mail className="size-4" aria-hidden="true" />{t("email")}</Label>
              <Input id="report_email" name="report_email" type="email" autoComplete="email" defaultValue={preferences.report_email ?? ""} placeholder={t("emailPlaceholder")} className="h-11" />
              <p className="text-xs text-muted-foreground">{t("emailHelp")}</p>
            </div>
          ) : null}
          <Button type="submit" size="lg" className="w-full">{t("savePreferences")}</Button>
          {preferences.next_report_at ? <p className="text-center text-xs text-muted-foreground">{t("nextReport", { date: formatDateTime(preferences.next_report_at) })}</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}

async function NoData() {
  const t = await getTranslations("BusinessInsights");
  return (
    <Card className="border-dashed py-12 text-center">
      <CardContent className="mx-auto max-w-xl">
        <Sparkles className="mx-auto size-8 text-primary" aria-hidden="true" />
        <h2 className="mt-4 text-xl font-semibold">{t("noDataTitle")}</h2>
        <p className="mt-2 leading-6 text-muted-foreground">{t("noDataDescription")}</p>
      </CardContent>
    </Card>
  );
}

function PlanRestricted({ plan, title, description }: { plan: string; title: string; description: string }) {
  return <Card className="mx-auto mt-12 max-w-xl py-10 text-center"><CardContent><ShieldCheck className="mx-auto size-9 text-muted-foreground" aria-hidden="true" /><Badge variant="outline" className="mt-4 uppercase">{plan}</Badge><h1 className="mt-4 text-2xl font-bold">{title}</h1><p className="mx-auto mt-2 max-w-md leading-6 text-muted-foreground">{description}</p></CardContent></Card>;
}

function Notice({ children, tone }: { children: React.ReactNode; tone: "success" | "warning" }) {
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return <div role="status" className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${tone === "success" ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"}`}><Icon className="size-4" aria-hidden="true" />{children}</div>;
}

function formatPeriod(start: string, end: string) {
  const formatter = new Intl.DateTimeFormat("pt-AO", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Luanda" });
  return `${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("pt-AO", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Luanda" }).format(new Date(value));
}
