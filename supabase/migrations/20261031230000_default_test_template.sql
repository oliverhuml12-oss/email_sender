-- A ready-made template for checking that sending, variables and tracking work.
insert into public.templates (name, subject, html, text_body)
select
  'Test email',
  'Test email for {{first_name | you}}',
  $html$<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#222222;max-width:600px;">
  <p style="margin:0 0 14px;">Hi {{first_name | there}},</p>
  <p style="margin:0 0 14px;">This is a test email from the email sender. If you can read this, sending works.</p>
  <p style="margin:0 0 14px;">Filled-in details for this contact:<br>
    Name: {{first_name | (no first name)}} {{last_name}}<br>
    Company: {{company | (no company)}}<br>
    Email: {{email}}</p>
  <p style="margin:0 0 14px;">Test link (counts as a click when click tracking is on): <a href="https://www.google.com" style="color:#1f3a5f;">www.google.com</a></p>
  <p style="margin:0 0 4px;">Best regards,</p>
  <p style="margin:0;">Email Sender</p>
</div>
</body>
</html>$html$,
  null
where not exists (select 1 from public.templates where name = 'Test email');
