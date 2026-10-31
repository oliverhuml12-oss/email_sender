// Starter templates. Table layout + inline styles so they render in Gmail, Outlook and Apple Mail.

export const STARTERS: { name: string; note: string; subject: string; html: string }[] = [
  {
    name: "Personal (best for cold first emails)",
    note: "Looks like a normal email you typed. Highest inbox placement.",
    subject: "{{company | Your team}} + quick question",
    html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#222222;max-width:600px;">
  <p style="margin:0 0 14px;">Hi {{first_name | there}},</p>
  <p style="margin:0 0 14px;">I came across {{company | your company}} and wanted to reach out with a short question.</p>
  <p style="margin:0 0 14px;">[One or two sentences about the problem you solve and why it matters to them.]</p>
  <p style="margin:0 0 14px;">Would it make sense to have a 15-minute call next week?</p>
  <p style="margin:0 0 4px;">Best regards,</p>
  <p style="margin:0;">Your Name<br><span style="color:#777777;">Your Company · +420 000 000 000</span></p>
</div>
</body>
</html>`,
  },
  {
    name: "Designed (for warm leads and follow-ups)",
    note: "Header with logo, a button and a footer. Expect more Promotions-tab placement for cold sends.",
    subject: "{{first_name | Hi}}, here's what we can do for {{company | you}}",
    html: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @media (max-width: 620px) { .container { width: 100% !important; } .px { padding-left: 20px !important; padding-right: 20px !important; } }
</style>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;background:#ffffff;border-radius:8px;">
        <tr>
          <td class="px" style="padding:28px 40px 8px;">
            <!-- Replace with your logo: an https image URL, about 140px wide -->
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:#1f3a5f;">YourCompany</div>
          </td>
        </tr>
        <tr>
          <td class="px" style="padding:16px 40px 8px;font-family:Arial,Helvetica,sans-serif;">
            <h1 style="margin:0 0 16px;font-size:24px;line-height:32px;color:#111827;">Hi {{first_name | there}},</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#374151;">[Opening line that's specific to {{company | their company}}.]</p>
            <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#374151;">[What you offer, in two or three short sentences. Focus on the result for them.]</p>
          </td>
        </tr>
        <tr>
          <td class="px" style="padding:0 40px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="border-radius:6px;background:#1f3a5f;">
                  <a href="https://example.com" style="display:inline-block;padding:12px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">Book a 15-minute call</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="px" style="padding:20px 40px 28px;border-top:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#6b7280;">
            Your Name · Your Company<br>
            Street 1, 110 00 Praha · +420 000 000 000
            {{unsubscribe_footer}}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.replace(
      "{{unsubscribe_footer}}",
      `<br><a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>`,
    ),
  },
];

export const VARIABLES = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email" },
  { key: "unsubscribe_url", label: "Unsubscribe link" },
];
