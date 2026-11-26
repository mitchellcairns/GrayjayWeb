import { onMount } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { extractUrl } from "../lib/nav";
import { openAnyUrl } from "./Search";
import { toastError } from "../components/Toasts";

/** Web Share Target (Android): "Share → Grayjay" from another app lands here with ?url= or ?text=. */
export default function Share() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  onMount(async () => {
    const url = extractUrl(String(params.url ?? "")) ?? extractUrl(String(params.text ?? "")) ?? extractUrl(String(params.title ?? ""));
    navigate("/", { replace: true });
    if (!url) return;
    try { await openAnyUrl(url, (to) => navigate(to)); } catch (e) { toastError(e); }
  });
  return <div class="page"><div class="feed-status"><div class="spinner" /></div></div>;
}
