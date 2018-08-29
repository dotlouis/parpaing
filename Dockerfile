FROM node:10.9-alpine
COPY . .
RUN npm ci --production
EXPOSE 3000
CMD ["npm", "start"]