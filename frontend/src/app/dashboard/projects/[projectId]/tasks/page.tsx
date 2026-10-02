import { ProjectTasks } from "@/components/workforce";

export default async function ProjectTasksRoute({ params }: { params: Promise<{ projectId: string }> }) { return <ProjectTasks projectId={(await params).projectId} />; }