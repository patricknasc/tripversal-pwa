import { Resend } from 'resend';

let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY!);
  return _resend;
}
export { getResend as resend };

export function buildInviteEmail(inviterName: string, tripName: string, token: string): string {
  const link = `https://tripversal-pwa.vercel.app/?invite=${token}`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Join ${tripName} on Voyasync</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <div style="color:#00e5ff;font-size:22px;font-weight:900;letter-spacing:4px;margin-bottom:8px;">VOYASYNC</div>
    <div style="color:#636366;font-size:13px;margin-bottom:40px;">Your travel companion</div>
    <div style="background:#141414;border-radius:20px;padding:32px;border:1px solid #2a2a2e;">
      <div style="font-size:24px;font-weight:800;color:#ffffff;margin-bottom:12px;">You're invited!</div>
      <p style="color:#8e8e93;font-size:15px;line-height:1.6;margin:0 0 24px;">
        <strong style="color:#ffffff;">${inviterName}</strong> has invited you to join their Travel Crew for
        <strong style="color:#00e5ff;">${tripName}</strong> on Voyasync.
      </p>
      <a href="${link}" style="display:block;background:#00e5ff;color:#000000;text-align:center;font-weight:800;font-size:15px;border-radius:14px;padding:16px 24px;text-decoration:none;letter-spacing:0.5px;">
        Join Travel Crew →
      </a>
      <p style="color:#636366;font-size:12px;margin:20px 0 0;text-align:center;">
        This invite expires in 7 days.
      </p>
    </div>
    <div style="color:#3a3a3c;font-size:11px;text-align:center;margin-top:24px;">
      Voyasync · Your travel companion
    </div>
  </div>
</body>
</html>`;
}
