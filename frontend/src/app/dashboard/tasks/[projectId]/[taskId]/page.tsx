import { TaskDetail } from "@/components/task-detail";

export default async function TaskRoute({ params }: { params: Promise<{ projectId: string; taskId: string }> }) { const resolved = await params; return <TaskDetail projectId={resolved.projectId} taskId={resolved.taskId} />; }