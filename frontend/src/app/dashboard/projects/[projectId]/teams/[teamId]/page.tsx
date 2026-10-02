import { TeamDetail } from "@/components/relationships";

export default async function TeamRoute({ params }: { params: Promise<{ projectId: string; teamId: string }> }) { const resolved = await params; return <TeamDetail projectId={resolved.projectId} teamId={resolved.teamId} />; }