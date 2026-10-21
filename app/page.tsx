import { connection } from "next/server";
import { KeepsakeLibrary } from "@/components/keepsake-library";
import { Providers } from "@/components/providers";

export default async function Page() {
  await connection();
  return (
    <Providers>
      <KeepsakeLibrary />
    </Providers>
  );
}
