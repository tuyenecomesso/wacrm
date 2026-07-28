import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function Forbidden() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-lg py-10 text-center">
        <CardContent>
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">403</p>
          <h1 className="mt-3 text-2xl font-bold">Sem acesso a este workspace</h1>
          <p className="mt-2 text-muted-foreground">A sua conta não tem permissão para consultar este relatório.</p>
          <Button className="mt-6" render={<Link href="/dashboard" />}>Voltar ao painel</Button>
        </CardContent>
      </Card>
    </main>
  );
}
