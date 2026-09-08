import { PageHeading } from "@/components/dashboard/page-heading";
import { RosterTable } from "@/components/team/roster-table";
import { TeamProfileForm } from "@/components/team/team-profile-form";

export const metadata = { title: "Team · Astra" };

export default function TeamPage() {
  return (
    <>
      <PageHeading
        title="Team configuration"
        description="Tell Astra who is in the room and how each person maps onto your Jira project and GitHub organization."
      />
      <div className="flex flex-col gap-6">
        <TeamProfileForm />
        <RosterTable />
      </div>
    </>
  );
}
