import { redirect } from "next/navigation";

/** The middleware handles the signed-out case, so this is a straight forward. */
export default function Home() {
  redirect("/dashboard");
}
