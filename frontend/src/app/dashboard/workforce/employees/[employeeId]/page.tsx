import { EmployeeDetail } from "@/components/workforce";

export default async function EmployeeRoute({ params }: { params: Promise<{ employeeId: string }> }) { return <EmployeeDetail employeeId={(await params).employeeId} />; }