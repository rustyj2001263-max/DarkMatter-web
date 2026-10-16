import icon from '../../assets/img/branding/icon-transparent.png';
import Button from '@mui/material/Button/Button';
import React, { FC } from 'react';
import { Link } from 'react-router-dom';

import { useSystemInfo } from 'hooks/useSystemInfo';

const ServerButton: FC = () => {
    const {
        data: systemInfo,
        isPending
    } = useSystemInfo();

    return (
        <Button
            variant='text'
            size='large'
            color='inherit'
            startIcon={
                <img
                    src={icon}
                    alt=''
                    aria-hidden
                    // Dark Matter Media: the square logo needs more room than the stock icon
                    style={{
                        maxHeight: '48px',
                        maxWidth: '48px'
                    }}
                />
            }
            component={Link}
            to='/'
        >
            {isPending ? '' : (systemInfo?.ServerName || 'Dark Matter Media')}
        </Button>
    );
};

export default ServerButton;
