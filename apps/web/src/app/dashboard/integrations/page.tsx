import { Chrome, Github, SquareKanban } from "lucide-react";

import { PageHeading } from "@/components/dashboard/page-heading";
import {
  IntegrationCard,
  type IntegrationCardProps,
} from "@/components/integrations/integration-card";

export const metadata = { title: "Integrations · Astra" };

const integrations: IntegrationCardProps[] = [
  {
    name: "Jira Workspace",
    description: "Files detected action items as issues in your project backlog.",
    icon: <SquareKanban className="h-4 w-4 text-white" aria-hidden />,
    accent: "from-indigo to-blue-500",
    connected: true,
    fields: [
      {
        key: "domain",
        label: "Workspace domain",
        placeholder: "your-team.atlassian.net",
        hint: "Atlassian cloud host, without https://.",
      },
      {
        key: "token",
        label: "API token",
        placeholder: "ATATT3xFfGF0...",
        secret: true,
        hint: "Created under Atlassian account security settings.",
      },
    ],
  },
  {
    name: "GitHub Organization",
    description: "Links commits and pull requests back to the meeting that produced them.",
    icon: <Github className="h-4 w-4 text-white" aria-hidden />,
    accent: "from-slate-600 to-slate-800",
    fields: [
      {
        key: "org",
        label: "Organization URL",
        placeholder: "https://github.com/your-org",
      },
      {
        key: "pat",
        label: "Personal access token",
        placeholder: "ghp_...",
        secret: true,
        hint: "Fine-grained token with repo read access.",
      },
      {
        key: "webhook",
        label: "Webhook secret",
        placeholder: "whsec_...",
        secret: true,
        hint: "Verifies payloads delivered to the Astra gateway.",
      },
    ],
  },
  {
    name: "Google Workspace",
    description: "Grants the bot calendar visibility so it can join scheduled Meet calls.",
    icon: <Chrome className="h-4 w-4 text-white" aria-hidden />,
    accent: "from-emerald to-teal-600",
    fields: [
      {
        key: "domain",
        label: "Primary domain",
        placeholder: "your-company.com",
      },
      {
        key: "serviceAccount",
        label: "Service account key",
        placeholder: "Paste the JSON key",
        secret: true,
        hint: "Stored server-side only — never exposed to the browser.",
      },
    ],
  },
];

export default function IntegrationsPage() {
  return (
    <>
      <PageHeading
        title="Integration hub"
        description="Connect the systems Astra reads from and writes to. Credentials are held in the backend vault; this form never persists them in the browser."
      />
      <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
        {integrations.map((integration) => (
          <IntegrationCard key={integration.name} {...integration} />
        ))}
      </div>
    </>
  );
}
