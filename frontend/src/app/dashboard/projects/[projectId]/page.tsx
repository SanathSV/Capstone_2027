import { ProjectDetail } from "@/components/projects";

export default async function ProjectRoute({ params }: { params: Promise<{ projectId: string }> }) { return <ProjectDetail projectId={(await params).projectId} />; }