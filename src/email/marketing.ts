import mailchimp from '@mailchimp/mailchimp_marketing';

// Configure Mailchimp
mailchimp.setConfig({
  apiKey: process.env.MAILCHIMP_API_KEY,
  server: 'us14'
});

export async function subscribeEmail(email: string, listId: string) {
  try {
    const response = await mailchimp.lists.addListMember(listId, {
      email_address: email,
      status: 'subscribed',
    });
    console.log('Successfully added contact as an audience member:', response);
  } catch (error) {
    console.error('Error adding contact to audience:', error);
  }
}