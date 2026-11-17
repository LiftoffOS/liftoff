// Shared HTML constants for email templates
// DO NOT reformat or modify whitespace

// Liftoff branded colors
export const EMAIL_COLORS = {
  background: '#ffffff',
  text: '#1e1e1e',
  textMuted: 'rgba(64, 64, 64, 0.6)',
  footerBg: '#f7f7f7',
  accent: '#FB411F',
  // Neutral grey for secondary/outline buttons — matches the site's
  // .btn--outline (grey border, grey text), NOT the orange accent. Solid hex
  // (not the site's translucent tokens) so it renders consistently in email.
  outlineBorder: '#c4c4c4',
  outlineText: '#595959',
};

export const DOCTYPE = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">`;

export const HEAD = `  <head>
    <meta content="width=device-width" name="viewport" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta content="IE=edge" http-equiv="X-UA-Compatible" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta content="telephone=no,address=no,email=no,date=no,url=no" name="format-detection" />
    <!--[if !mso]><!-->
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light only" />
    <!--<![endif]-->
    <style>
      :root { color-scheme: light only; supported-color-schemes: light only; }
      @media (prefers-color-scheme: dark) {
        .body-wrapper, .content-wrapper, body, .email-body { background-color: ${EMAIL_COLORS.background} !important; }
        .light-footer { background-color: ${EMAIL_COLORS.footerBg} !important; }
        h1, p, span, li, td { color: ${EMAIL_COLORS.text} !important; }
        .footer-text { color: ${EMAIL_COLORS.text} !important; }
        a.cta-button { background-color: ${EMAIL_COLORS.accent} !important; color: #ffffff !important; }
      }
      [data-ogsc] .body-wrapper, [data-ogsc] .content-wrapper, [data-ogsc] body { background-color: ${EMAIL_COLORS.background} !important; }
      [data-ogsc] .light-footer { background-color: ${EMAIL_COLORS.footerBg} !important; }
      [data-ogsc] h1, [data-ogsc] p, [data-ogsc] span, [data-ogsc] li, [data-ogsc] td { color: ${EMAIL_COLORS.text} !important; }
      [data-ogsc] .footer-text { color: ${EMAIL_COLORS.text} !important; }
      u + .body .body-wrapper { background-color: ${EMAIL_COLORS.background} !important; }
    </style>
  </head>

`;

export const BODY_OPEN = `  <body class="email-body" style="margin:0;padding:0;background-color:${EMAIL_COLORS.background};-webkit-text-size-adjust:none;text-size-adjust:none;">
    <div
      style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;mso-hide:all;font-size:1px;color:${EMAIL_COLORS.background};"
      data-skip-in-text="true"
    >`;

export const WRAPPER_START = `    </div>

    <table
      class="body-wrapper"
      border="0"
      width="100%"
      cellpadding="0"
      cellspacing="0"
      role="presentation"
      align="center"
      style="margin:0;padding:0;background-color:${EMAIL_COLORS.background};"
    >
      <tbody>
        <tr>
          <td class="content-wrapper" style="margin:0;padding:0;background-color:${EMAIL_COLORS.background};">
            <table
              align="center"
              width="100%"
              border="0"
              cellpadding="0"
              cellspacing="0"
              role="presentation"
              style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif;font-size:16px;line-height:155%;background-color:${EMAIL_COLORS.background};"
            >
              <tbody>
                <tr>
                  <td align="center">
                    <table
                      align="center"
                      width="100%"
                      border="0"
                      cellpadding="0"
                      cellspacing="0"
                      role="presentation"
                      style="width:100%;max-width:600px;line-height:155%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif;"
                    >
                      <tbody>
                        <tr>
                          <td>
                            <table
                              width="100%"
                              border="0"
                              cellpadding="0"
                              cellspacing="0"
                              role="presentation"
                              style="padding:10px 20px;box-sizing:border-box;background-color:${EMAIL_COLORS.background};"
                            >
                              <tbody>
                                <tr>
                                  <td>`;

export const CONTENT_TABLE_START = `                                  </td>
                                </tr>
                              </tbody>
                            </table>

                            <table
                              width="100%"
                              border="0"
                              cellpadding="0"
                              cellspacing="0"
                              role="presentation"
                              style="padding:10px 20px;box-sizing:border-box;background-color:${EMAIL_COLORS.background};"
                            >
                              <tbody>
                                <tr>
                                  <td>`;

export const CONTENT_TABLE_END = `                                  </td>
                                </tr>
                              </tbody>
                            </table>
`;

export const FOOTER = `                            <table
                              class="light-footer"
                              width="100%"
                              border="0"
                              cellpadding="0"
                              cellspacing="0"
                              role="presentation"
                              style="padding:10px 20px;box-sizing:border-box;background-color:${EMAIL_COLORS.footerBg};"
                            >
                              <tbody>
                                <tr>
                                  <td class="light-footer" style="background-color:${EMAIL_COLORS.footerBg};">
                                    <table
                                      align="center"
                                      width="100%"
                                      border="0"
                                      cellpadding="0"
                                      cellspacing="0"
                                      role="presentation"
                                    >
                                      <tbody>
                                        <tr>
                                          <td
                                            width="140"
                                            style="width:140px;padding-top:16px;padding-right:12px;padding-bottom:16px;padding-left:0;vertical-align:middle;"
                                          >
                                              <img src="cid:logo" width="42" height="16" alt="Liftoff" style="display:block;border:0;outline:none;text-decoration:none;height:16.195px;width:42.211px;pointer-events:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;" />
                                          </td>

                                          <td style="vertical-align:middle;text-align:right;">
                                            <p
                                              class="footer-text"
                                              style="margin:0;font-size:12px;line-height:1.5;color:${EMAIL_COLORS.textMuted};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;white-space:nowrap;"
                                            >
                                              The Operating System for Agents
                                            </p>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              </tbody>
                            </table>`;

export const CLOSING = `                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`;
