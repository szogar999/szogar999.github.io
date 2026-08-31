// ============================================================
// ai-gateway — WERSJA HEALTH-CHECK (Sprint AI, krok 1)
//
// Na tym etapie funkcja NIE woła modelu. Sprawdza wyłącznie
// fundament, na którym stanie cała reszta:
//   1. czy JWT użytkownika dociera z przeglądarki,
//   2. czy klient Supabase zbudowany z tym JWT widzi usera,
//   3. czy RLS działa (odczyt clients przez uprawnienia usera),
//   4. czy sekret Anthropic jest dostępny PO STRONIE SERWERA.
//
// ZASADA: nigdzie nie używamy SERVICE_ROLE_KEY do danych
// biznesowych. Klient tworzony jest z ANON_KEY + nagłówkiem
// Authorization użytkownika, więc każde zapytanie przechodzi
// przez te same polityki co przeglądarka.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function fail(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // ---------- 1. JWT ----------
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return fail("AI01", "Brak nagłówka Authorization z tokenem użytkownika.", 401);
    }

    // ---------- 2. Klient Supabase Z TOKENEM UŻYTKOWNIKA ----------
    // ANON_KEY + Authorization = RLS obowiązuje.
    // NIE używamy service_role — to byłoby obejście uprawnień.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return fail("AI01", "Token nieważny lub wygasł.", 401);
    }
    const user = userData.user;

    // ---------- 3. Rola i test RLS ----------
    // my_role() czyta z public.users po auth.uid().
    const { data: roleData } = await supabase.rpc("my_role");

    // Liczba klientów WIDOCZNYCH dla tego użytkownika.
    // Owner zobaczy wszystkich, sales tylko swoich — to dowód,
    // że RLS działa wewnątrz Edge Function tak samo jak w przeglądarce.
    const { count: visibleClients, error: cliErr } = await supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null);

    // ---------- 4. Sekret Anthropic ----------
    // Sprawdzamy TYLKO obecność i długość. Klucz NIGDY nie trafia
    // do odpowiedzi — inaczej wyciekłby do przeglądarki.
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    const secretOk = apiKey.length > 20 && apiKey.startsWith("sk-");

    return json({
      ok: true,
      data: {
        health: "ok",
        version: "ai-gateway/0.1-healthcheck",
        user: {
          id: user.id,
          email: user.email,
          role: roleData ?? null,
        },
        rls: {
          visible_clients: visibleClients ?? 0,
          error: cliErr?.message ?? null,
        },
        secrets: {
          anthropic_key_present: secretOk,
          anthropic_key_length: apiKey.length, // sama długość, nigdy treść
        },
      },
      meta: { cached: false, model: null, cost_usd: 0 },
    });
  } catch (e) {
    return fail("AI08", `Błąd wewnętrzny: ${String(e).slice(0, 200)}`, 500);
  }
});
