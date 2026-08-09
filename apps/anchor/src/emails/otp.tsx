import * as React from 'react';
import { Tailwind, Section, Text } from '@react-email/components';

export default function OTPEmail({
  otp,
  intent,
}: {
  otp: number;
  intent: 'verify-email' | 'reset-password' | 'login';
}) {
  return (
    <Tailwind>
      <Section className="flex justify-center items-center w-full min-h-screen font-sans">
        <Section className="flex flex-col items-center w-76 rounded-2xl px-6 py-1 bg-mauve-50">
          <Text className="text-xs font-medium text-violet-500">
            {intent === 'verify-email'
              ? 'verify your email address'
              : intent === 'login'
                ? 'confirm your sign-in'
                : 'reset your password'}
          </Text>
          <Text className="text-mauve-500 my-0">
            {intent === 'verify-email'
              ? 'please use the following code to verify your email address'
              : intent === 'login'
                ? 'please use the following code to finish signing in to novarum'
                : 'please use the following code to start the password reset process'}
          </Text>
          <Text className="text-5xl font-bold pt-2">{otp}</Text>
          <Text className="text-mauve-400 font-light text-xs pb-4">
            this code is valid for 10 minutes
          </Text>
          <Text className="text-mauve-600 text-xs">
            thank you for helping us help you help us all
          </Text>
        </Section>
      </Section>
    </Tailwind>
  );
}

OTPEmail.PreviewProps = {
  otp: 123456,
  intent: 'verify-email',
};
