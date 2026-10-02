import { TeamsPage } from "@/components/relationships";

export default async function ProjectTeamsRoute({ params }: { params: Promise<{ projectId: string }> }) { return <TeamsPage projectId={(await params).projectId} />; }